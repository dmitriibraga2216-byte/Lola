-- docs/v2/45-plan.md PR-32 · docs/v2/38-people-extensions.md §3.4, §3.5, §4, §7.4–§7.8 ·
-- docs/v2/43-reconciliation.md §1.2 (`person_notes` = существующая `user_notes`) ·
-- docs/v2/40-data-model-delta.md §7.1–§7.2 (частичный индекс заметок + полный рядом)
--
-- Заметки и документы человека. Пакет заводил `person_notes` отдельной таблицей, но заметки
-- уже жили в `user_notes` (0019_people_spec16) — это одна сущность, поэтому здесь
-- `alter table user_notes` на семь колонок и четыре констрейнта, а не вторая таблица.
-- Документы — две новые тенантные таблицы: справочник типов и сами документы.
--
-- Перечень `media_assets.origin` НЕ трогается (CLAUDE.md инвариант 19): значение
-- `person_document` уже есть в реестре `docs/v2/40` §4.2 и в констрейнте (0063, 0069).

-- ── 1. user_notes: семь колонок (`38` §3.4) ─────────────────────────────────────────────
ALTER TABLE "user_notes" ADD COLUMN "visibility" text DEFAULT 'manager' NOT NULL;--> statement-breakpoint
ALTER TABLE "user_notes" ADD COLUMN "category" text DEFAULT 'general' NOT NULL;--> statement-breakpoint
ALTER TABLE "user_notes" ADD COLUMN "is_pinned" boolean DEFAULT false NOT NULL;--> statement-breakpoint
ALTER TABLE "user_notes" ADD COLUMN "flagged_at" timestamp with time zone;--> statement-breakpoint
ALTER TABLE "user_notes" ADD COLUMN "flagged_terms" text[] DEFAULT '{}'::text[] NOT NULL;--> statement-breakpoint
ALTER TABLE "user_notes" ADD COLUMN "shared_at" timestamp with time zone;--> statement-breakpoint
ALTER TABLE "user_notes" ADD COLUMN "archived_at" timestamp with time zone;--> statement-breakpoint

-- ── 2. Заметки до PR-32 под новые констрейнты ───────────────────────────────────────────
-- До этой миграции заметку принимала схема `min(1).max(2000)` без запрета писать о себе,
-- поэтому на живых данных могут встретиться две вещи, которые констрейнты ниже отвергнут.
-- Ни одна заметка при этом не удаляется и её текст не меняется по смыслу:
--
-- (а) Текст короче трёх знаков («ок», «+»). Добивается пробелами до трёх: видимый текст тот
--     же, а `char_length` проходит `user_notes_body_chk`. Иначе такая заметка не смогла бы
--     даже уйти в архив — любой `update` строки перепроверяет check.
UPDATE "user_notes" SET "body" = rpad("body", 3) WHERE char_length("body") < 3;--> statement-breakpoint
-- (б) Заметка о самом себе (`author_id = user_id`). По модели §3.4 заметка — служебная
--     запись о человеке от другого человека, `user_notes_self_chk` её запрещает. Автор
--     обнуляется, но не теряется: прежнее значение уходит в `audit_log` отдельной записью,
--     чтобы «кто это написал» оставалось восстановимым.
INSERT INTO "audit_log" ("tenant_id", "actor_id", "action", "entity", "entity_id", "before", "after")
SELECT n."tenant_id", NULL, 'person_note.author_cleared', 'user_notes', n."id",
       jsonb_build_object('authorId', n."author_id"),
       jsonb_build_object('authorId', NULL, 'reason', 'self_note_before_pr32')
FROM "user_notes" n WHERE n."author_id" = n."user_id";--> statement-breakpoint
UPDATE "user_notes" SET "author_id" = NULL WHERE "author_id" = "user_id";--> statement-breakpoint

-- ── 3. Четыре констрейнта (`38` §3.4) и ключ на tenants ─────────────────────────────────
ALTER TABLE "user_notes" ADD CONSTRAINT "user_notes_visibility_chk" CHECK ("visibility" IN ('hr', 'manager', 'shared_with_person'));--> statement-breakpoint
ALTER TABLE "user_notes" ADD CONSTRAINT "user_notes_category_chk" CHECK ("category" IN ('general', 'onboarding', 'performance', 'training_plan', 'incident', 'agreement'));--> statement-breakpoint
ALTER TABLE "user_notes" ADD CONSTRAINT "user_notes_body_chk" CHECK (char_length("body") BETWEEN 3 AND 2000);--> statement-breakpoint
ALTER TABLE "user_notes" ADD CONSTRAINT "user_notes_self_chk" CHECK ("author_id" <> "user_id");--> statement-breakpoint
-- Внешнего ключа на tenants у user_notes не было с 0019. Таблица — та самая `person_notes`
-- пакета под своим именем, и контрактный тест №3 (FK на tenants с on delete cascade) теперь
-- распространяется на неё: она добавлена в `tests/integration/v2-package-tables.ts`.
ALTER TABLE "user_notes" ADD CONSTRAINT "user_notes_tenant_id_tenants_id_fk" FOREIGN KEY ("tenant_id") REFERENCES "public"."tenants"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint

-- ── 4. Индексы (`38` §3.4, `40` §7.1–§7.2) ───────────────────────────────────────────────
-- Частичный — горячий путь карточки (неархивные заметки человека). Полный рядом — холодный
-- путь: архив для admin по прямой ссылке и `gdpr.erase`, обходящий все заметки человека;
-- контрактный тест №2 требует именно полного tenant-first индекса. Прежний
-- `user_notes_tenant_id_index (tenant_id)` полностью покрыт полным составным и снимается.
DROP INDEX IF EXISTS "user_notes_tenant_id_index";--> statement-breakpoint
CREATE INDEX "idx_user_notes_tenant" ON "user_notes" USING btree ("tenant_id","user_id","created_at" DESC) WHERE "archived_at" IS NULL;--> statement-breakpoint
CREATE INDEX "idx_user_notes_tenant_all" ON "user_notes" USING btree ("tenant_id","user_id","created_at" DESC);--> statement-breakpoint
COMMENT ON COLUMN "user_notes"."visibility" IS 'person_note_visibility: hr | manager | shared_with_person (docs/v2/38 §7.4). shared_with_person назад не сужается — 409 visibility_narrowing_forbidden';--> statement-breakpoint
COMMENT ON COLUMN "user_notes"."category" IS 'person_note_category (docs/v2/38 §3.4): определяет срок хранения — 24 месяца, training_plan/agreement/закреплённые — 36 (§7.6)';--> statement-breakpoint
COMMENT ON COLUMN "user_notes"."flagged_at" IS 'Сохранено вопреки лексическому скрину чувствительного содержания (docs/v2/38 §7.5): не блокирует, отмечает';--> statement-breakpoint
COMMENT ON COLUMN "user_notes"."archived_at" IS 'Архив по сроку хранения — notes.archive_scan (docs/v2/38 §7.6); из карточки исчезает, admin видит по прямой ссылке';--> statement-breakpoint

-- ── 5. person_document_types — справочник типов (`38` §3.5) ─────────────────────────────
CREATE TABLE "person_document_types" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	"updated_at" timestamp with time zone DEFAULT now() NOT NULL,
	"tenant_id" uuid NOT NULL,
	"code" text NOT NULL,
	"name" text NOT NULL,
	"is_system" boolean DEFAULT false NOT NULL,
	"is_required" boolean DEFAULT false NOT NULL,
	"required_positions" uuid[] DEFAULT '{}'::uuid[] NOT NULL,
	"validity_months" integer,
	"remind_days" integer[] DEFAULT '{30,7,0}'::integer[] NOT NULL,
	"is_fact_only" boolean DEFAULT false NOT NULL,
	"self_upload" boolean DEFAULT false NOT NULL,
	"visible_to_manager" boolean DEFAULT true NOT NULL,
	"is_active" boolean DEFAULT true NOT NULL,
	CONSTRAINT "person_document_types_tenant_id_code_unique" UNIQUE("tenant_id","code")
);--> statement-breakpoint
ALTER TABLE "person_document_types" ADD CONSTRAINT "person_document_types_tenant_id_tenants_id_fk" FOREIGN KEY ("tenant_id") REFERENCES "public"."tenants"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
-- tenant-first, непартиальный (контрактный тест №2)
CREATE INDEX "idx_person_document_types_tenant" ON "person_document_types" USING btree ("tenant_id","is_active");--> statement-breakpoint
ALTER TABLE person_document_types ENABLE ROW LEVEL SECURITY;--> statement-breakpoint
ALTER TABLE person_document_types FORCE ROW LEVEL SECURITY;--> statement-breakpoint
CREATE POLICY tenant_isolation ON person_document_types
  USING (tenant_id = nullif(current_setting('app.tenant_id', true), '')::uuid)
  WITH CHECK (tenant_id = nullif(current_setting('app.tenant_id', true), '')::uuid);--> statement-breakpoint
COMMENT ON COLUMN "person_document_types"."is_fact_only" IS 'Файл запрещён на уровне API — хранится факт, срок и маскированный номер (docs/v2/38 §7.7): 422 document_file_not_allowed';--> statement-breakpoint
COMMENT ON COLUMN "person_document_types"."required_positions" IS 'Для каких посад тип обязателен; пустой массив — для всех (docs/v2/38 §7.8)';--> statement-breakpoint

-- ── 6. person_documents — документ человека (`38` §3.5, §4) ─────────────────────────────
-- Сверх DDL §3.5 — `revoked_at`, `revoke_reason`, `replaced_by_id`: §4 требует отмену «с
-- причиной» и «с причиной «Замінено документом від {дата}»», а в DDL для причины места нет
-- (`note` — примечание загрузившего, затирать его отменой нельзя).
CREATE TABLE "person_documents" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	"updated_at" timestamp with time zone DEFAULT now() NOT NULL,
	"tenant_id" uuid NOT NULL,
	"user_id" uuid NOT NULL,
	"type_id" uuid NOT NULL,
	"media_id" uuid,
	"title" text,
	"number_masked" text,
	"issued_at" date,
	"expires_at" date,
	"status" text DEFAULT 'valid' NOT NULL,
	"uploaded_by" uuid NOT NULL,
	"note" text,
	"revoked_at" timestamp with time zone,
	"revoke_reason" text,
	"replaced_by_id" uuid,
	CONSTRAINT "person_documents_status_chk" CHECK ("status" IN ('valid', 'expiring', 'expired', 'revoked')),
	CONSTRAINT "person_documents_dates_chk" CHECK ("expires_at" IS NULL OR "issued_at" IS NULL OR "expires_at" > "issued_at"),
	CONSTRAINT "person_documents_number_chk" CHECK ("number_masked" IS NULL OR char_length("number_masked") <= 8),
	CONSTRAINT "person_documents_revoked_chk" CHECK (("status" = 'revoked') = ("revoked_at" IS NOT NULL))
);--> statement-breakpoint
ALTER TABLE "person_documents" ADD CONSTRAINT "person_documents_tenant_id_tenants_id_fk" FOREIGN KEY ("tenant_id") REFERENCES "public"."tenants"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "person_documents" ADD CONSTRAINT "person_documents_user_id_users_id_fk" FOREIGN KEY ("user_id") REFERENCES "public"."users"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "person_documents" ADD CONSTRAINT "person_documents_type_id_person_document_types_id_fk" FOREIGN KEY ("type_id") REFERENCES "public"."person_document_types"("id") ON DELETE restrict ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "person_documents" ADD CONSTRAINT "person_documents_media_id_media_assets_id_fk" FOREIGN KEY ("media_id") REFERENCES "public"."media_assets"("id") ON DELETE set null ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "person_documents" ADD CONSTRAINT "person_documents_uploaded_by_users_id_fk" FOREIGN KEY ("uploaded_by") REFERENCES "public"."users"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "person_documents" ADD CONSTRAINT "person_documents_replaced_by_id_person_documents_id_fk" FOREIGN KEY ("replaced_by_id") REFERENCES "public"."person_documents"("id") ON DELETE set null ON UPDATE no action;--> statement-breakpoint
-- Индексы §3.5 дословно: полный tenant-first (контрактный тест №2) и частичный под
-- ночной скан сроков — он читает только то, что ещё может истечь.
CREATE INDEX "idx_person_documents_tenant" ON "person_documents" USING btree ("tenant_id","user_id","status");--> statement-breakpoint
CREATE INDEX "idx_person_documents_tenant_expiry" ON "person_documents" USING btree ("tenant_id","expires_at") WHERE "status" IN ('valid', 'expiring');--> statement-breakpoint
ALTER TABLE person_documents ENABLE ROW LEVEL SECURITY;--> statement-breakpoint
ALTER TABLE person_documents FORCE ROW LEVEL SECURITY;--> statement-breakpoint
CREATE POLICY tenant_isolation ON person_documents
  USING (tenant_id = nullif(current_setting('app.tenant_id', true), '')::uuid)
  WITH CHECK (tenant_id = nullif(current_setting('app.tenant_id', true), '')::uuid);--> statement-breakpoint
COMMENT ON COLUMN "person_documents"."number_masked" IS 'Только последние 4 знака номера — ****1234 (docs/v2/38 §7.7)';--> statement-breakpoint
COMMENT ON COLUMN "person_documents"."replaced_by_id" IS 'Более свежий документ того же типа, заменивший этот (docs/v2/38 §4): «Замінено документом від {дата}»';--> statement-breakpoint

-- ── 7. Семь системных типов уже заведённым тенантам (`38` §3.5) ─────────────────────────
-- Новые тенанты получают их из ensureTenantDefaults (server/db/tenantDefaults.ts,
-- SYSTEM_PERSON_DOCUMENT_TYPES): на чистой БД тенантов ещё нет и вставка отсюда пустая.
-- Здесь — догоняющая вставка тем же составом, идемпотентная по (tenant_id, code).
INSERT INTO person_document_types (tenant_id, code, name, is_system, is_required, validity_months, is_fact_only, self_upload)
SELECT t.id, s.code, s.name, true, s.is_required, s.validity_months, s.is_fact_only, s.self_upload
FROM tenants t
CROSS JOIN (VALUES
	('employment_contract',   'Трудовий договір',                 true,  NULL::integer, false, false),
	('labor_safety_briefing', 'Інструктаж з охорони праці',       true,  12,            false, false),
	('fire_safety_briefing',  'Інструктаж з пожежної безпеки',    true,  12,            false, false),
	('medical_book',          'Медична книжка',                   true,  12,            true,  false),
	('nda',                   'Угода про нерозголошення',         true,  NULL::integer, false, false),
	('external_certificate',  'Сертифікат стороннього навчання',  false, NULL::integer, false, true),
	('other',                 'Інше',                             false, NULL::integer, false, false)
) AS s(code, name, is_required, validity_months, is_fact_only, self_upload)
ON CONFLICT (tenant_id, code) DO NOTHING;--> statement-breakpoint

-- ── 8. Скоупы заметок и документов системным ролям (`38` §2) ────────────────────────────
-- Скоупы заведены PR-03 и до появления эндпоинтов были только у администратора свежих
-- тенантов. Руководитель точки читает заметки уровня `manager`, пишет свои и открывает их
-- человеку, видит документы типов `visible_to_manager` и загружает их своим людям — всё в
-- области своей роли. Администратору уже заведённых тенантов — догоняющая выдача: его набор
-- в БД собирался до PR-03. Добавляется только недостающее, порядок прежних сохраняется.
UPDATE roles SET scopes = scopes || ARRAY(
	SELECT s FROM unnest(ARRAY['person.note.read', 'person.note.write', 'person.document.view_others', 'person.document.manage']::text[]) AS s
	WHERE NOT s = ANY(roles.scopes)
)
WHERE is_system AND code IN ('manager', 'admin');
