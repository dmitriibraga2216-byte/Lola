-- docs/v2/45-plan.md PR-33 · Нормы отсутствий и сдвиг дедлайнов · docs/v2/38-people-extensions.md
-- §3.6 (DDL), §4 (состояния записи), §6.3–6.4 (формы), §7.12–7.14 (граница ответственности,
-- остаток, планирование), §10 (API), §13 к. 9–10 · docs/v2/40 §2.
--
-- ── Что здесь ───────────────────────────────────────────────────────────────────────────
-- 1. `absence_records` — факты отсутствий человека. `absence_norms` уже заведена PR-39
--    (миграция `v2_settings`) вместе с уровнями компании и точки; здесь — факты, по которым
--    считается остаток и сдвигается дедлайн.
-- 2. `enrollments.deadline_shifted_reason` — почему срок записи не тот, что дало назначение.
--    Дедлайн — параметр назначения (CLAUDE.md п. 11): он сдвигается в записи на курс, которую
--    назначение и создаёт, а не в контенте; колонка не в таблице контента (`schema-parity`).
-- 3. `person.absence.manage` руководителю точки (`38` §2: «Вносить факт отсутствия», норма
--    своей точки и своих людей) и догоняющая выдача администратору заведённых тенантов.
--
-- ── Отступления от DDL `38` §3.6 (решения записаны в `38` §3.6 пометкой PR-33) ──────────────
-- * `created_at`, `updated_at` — общие поля доменной таблицы (docs/02, преамбула): запись
--   правится (`PATCH`), и время правки нужно карточке.
-- * `created_by` nullable с `on delete set null` — как `absence_norms.set_by` (PR-39): стирание
--   человека по GDPR не должно упираться в чужую справочную запись.
-- * `absence_records_source_chk` — источник назван в DDL комментарием, перечень — docs/02.
-- * `absence_records_range_chk` дополнен пределом 366 дней, `absence_records_days_chk` держит
--   `days_count` равным календарной длине диапазона: `numeric(4,1)` из DDL переполнился бы на
--   тысячедневном периоде ошибкой вставки, а норма живёт календарным годом — длинное отсутствие
--   вносится записями по годам.
-- * `absence_records_comment_chk` — «коментар (≤300)» формы §6.4.
-- * Пересечение действующих записей не ограничено в БД (исключающему ограничению нужен
--   `btree_gist`) — его держит сервис под advisory-lock на человека: `409 absence_overlap`.

-- ── 1. Факты отсутствий ─────────────────────────────────────────────────────────────────
CREATE TABLE "absence_records" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	"updated_at" timestamp with time zone DEFAULT now() NOT NULL,
	"tenant_id" uuid NOT NULL,
	"user_id" uuid NOT NULL,
	"kind" text NOT NULL,
	"date_from" date NOT NULL,
	"date_to" date NOT NULL,
	"days_count" numeric(4, 1) NOT NULL,
	"status" text DEFAULT 'approved' NOT NULL,
	"source" text DEFAULT 'manual' NOT NULL,
	"comment" text,
	"created_by" uuid,
	CONSTRAINT "absence_records_kind_chk" CHECK ("kind" IN ('vacation', 'sick', 'unpaid', 'other')),
	CONSTRAINT "absence_records_status_chk" CHECK ("status" IN ('planned', 'approved', 'cancelled')),
	CONSTRAINT "absence_records_source_chk" CHECK ("source" IN ('manual', 'import', 'api')),
	CONSTRAINT "absence_records_range_chk" CHECK ("date_to" >= "date_from" AND "date_to" - "date_from" < 366),
	CONSTRAINT "absence_records_days_chk" CHECK ("days_count" = ("date_to" - "date_from" + 1)),
	CONSTRAINT "absence_records_comment_chk" CHECK ("comment" IS NULL OR char_length("comment") <= 300)
);
--> statement-breakpoint
ALTER TABLE "absence_records" ADD CONSTRAINT "absence_records_tenant_id_tenants_id_fk" FOREIGN KEY ("tenant_id") REFERENCES "public"."tenants"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "absence_records" ADD CONSTRAINT "absence_records_user_id_users_id_fk" FOREIGN KEY ("user_id") REFERENCES "public"."users"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "absence_records" ADD CONSTRAINT "absence_records_created_by_users_id_fk" FOREIGN KEY ("created_by") REFERENCES "public"."users"("id") ON DELETE set null ON UPDATE no action;--> statement-breakpoint
-- Полный индекс с tenant_id первым (контрактный тест 2): записи человека за год в карточке
CREATE INDEX "idx_absence_records_tenant" ON "absence_records" USING btree ("tenant_id","user_id","date_from");--> statement-breakpoint
-- Частичный — горячий путь планировщика: «кто отсутствует в эти даты» без отменённых
CREATE INDEX "idx_absence_records_tenant_range" ON "absence_records" USING btree ("tenant_id","date_from","date_to") WHERE "status" IN ('planned', 'approved');--> statement-breakpoint
ALTER TABLE absence_records ENABLE ROW LEVEL SECURITY;--> statement-breakpoint
ALTER TABLE absence_records FORCE ROW LEVEL SECURITY;--> statement-breakpoint
CREATE POLICY tenant_isolation ON absence_records
  USING (tenant_id = nullif(current_setting('app.tenant_id', true), '')::uuid)
  WITH CHECK (tenant_id = nullif(current_setting('app.tenant_id', true), '')::uuid);--> statement-breakpoint
COMMENT ON TABLE "absence_records" IS 'Факты отсутствий человека (docs/v2/38 §3.6, §7.13–7.14): справочная запись, не кадровый учёт. Остаток нормы — по approved; дедлайн обязательного назначения и напоминания блокируют planned и approved. Не путать с reviewer_absences (docs/v2/37).';--> statement-breakpoint
COMMENT ON COLUMN "absence_records"."days_count" IS 'Календарные дни диапазона включительно (docs/v2/38 §7.13): рабочие дни потребовали бы производственного календаря — это кадровый учёт, граница §7.12.';--> statement-breakpoint

-- ── 2. Причина сдвига дедлайна записи ───────────────────────────────────────────────────
ALTER TABLE "enrollments" ADD COLUMN "deadline_shifted_reason" text;--> statement-breakpoint
ALTER TABLE "enrollments" ADD CONSTRAINT "enrollments_deadline_shift_reason_chk" CHECK ("deadline_shifted_reason" IS NULL OR "deadline_shifted_reason" IN ('absence'));--> statement-breakpoint
COMMENT ON COLUMN "enrollments"."deadline_shifted_reason" IS 'Почему срок не тот, что дало назначение (docs/v2/38 §7.14): absence — сдвинут с дней отсутствия. Ручное продление причину снимает.';--> statement-breakpoint

-- ── 3. Скоуп отсутствий системным ролям (`38` §2) ───────────────────────────────────────
-- Руководитель точки вносит факты отсутствий своих людей, правит норму своей точки и
-- индивидуальную норму своих людей — в области своей роли (сервис проверяет точку человека).
-- Администратору заведённых тенантов — догоняющая выдача: его набор в БД собирался до PR-03.
-- Новые тенанты получают скоуп из SYSTEM_ROLES (`shared/domain/roles.ts`). Добавляется только
-- недостающее — повторная выдача не плодит дублей в массиве.
UPDATE roles SET scopes = scopes || ARRAY['person.absence.manage']::text[]
	WHERE is_system AND code IN ('manager', 'admin') AND NOT scopes @> ARRAY['person.absence.manage']::text[];
