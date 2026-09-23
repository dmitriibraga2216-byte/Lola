-- docs/v2/45-plan.md PR-13 · docs/v2/28-recruiting-candidates.md §3.2–§3.6 ·
-- docs/v2/40-data-model-delta.md §3.2 и §5 (0006 + 0013 + 0014) · docs/v2/44-decisions.md
-- В-8 (кандидат и сотрудник — одна запись users), В-13 (имена отложенных FK), В-14 (состав 0056).
--
-- Кандидат — это `users` с `kind = 'candidate'`. Отдельной таблицы людей нет и не будет:
-- прохождение контента уже завязано на `users` (`assignments`, `enrollments`, `attempts`,
-- `lesson_progress`), и вторая таблица потребовала бы либо дублировать всю цепочку, либо
-- делать полиморфные ссылки — и то и другое ломает RLS и внешние ключи (`28` §3.1).
--
-- Порядок внутри файла снимает оба цикла `40` §5 без отдельной миграции-развязки:
-- `candidate_statuses` создаётся первой (её `created_by` смотрит на уже существующий `users`),
-- и только потом `users` получает `candidate_status_id` вместе с FK `users_candidate_status_id_fk`
-- (имя зафиксировано В-13). `users.vacancy_id` и `users_vacancy_id_fk` здесь НЕ заводятся —
-- цикл `28 ↔ 29` разрывает миграция-развязка PR-15, вакансий ещё нет.

-- ── 1. Справочник колонок воронки (`28` §3.3, `40` §5 0006) ─────────────────────────────
-- Справочник расширяемый: тенант заводит свои колонки канбана. Но каждая обязана указать
-- `maps_to` — к какому из пяти терминальных состояний она приравнивается (`28` §4.1).
-- Без этого первая же пользовательская колонка («Передзвонити у січні») ломает отчётность
-- по воронке: отчёты, лимиты и уведомления смотрят на ось `candidate_state`, интерфейс — на
-- ось `candidate_status_id`, и связывает их только `maps_to`.
CREATE TABLE "candidate_statuses" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	"updated_at" timestamp with time zone DEFAULT now() NOT NULL,
	"tenant_id" uuid NOT NULL,
	"code" text NOT NULL,
	"name_uk" text NOT NULL,
	"name_en" text,
	"color" text DEFAULT 'ink' NOT NULL,
	"sort" integer NOT NULL,
	"is_system" boolean DEFAULT false NOT NULL,
	"maps_to" text DEFAULT 'active' NOT NULL,
	"is_active" boolean DEFAULT true NOT NULL,
	"created_by" uuid,
	CONSTRAINT "candidate_statuses_tenant_id_code_unique" UNIQUE("tenant_id","code"),
	CONSTRAINT "candidate_statuses_maps_to_chk" CHECK ("maps_to" IN ('active', 'hired', 'rejected', 'archived', 'withdrawn')),
	-- Только токены бренд-бука (CLAUDE.md п. 9): магических цветов у колонки канбана нет.
	CONSTRAINT "candidate_statuses_color_chk" CHECK ("color" IN ('ink', 'sun', 'teal', 'coral'))
);
--> statement-breakpoint
ALTER TABLE "candidate_statuses" ADD CONSTRAINT "candidate_statuses_tenant_id_tenants_id_fk" FOREIGN KEY ("tenant_id") REFERENCES "public"."tenants"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "candidate_statuses" ADD CONSTRAINT "candidate_statuses_created_by_users_id_fk" FOREIGN KEY ("created_by") REFERENCES "public"."users"("id") ON DELETE set null ON UPDATE no action;--> statement-breakpoint
CREATE INDEX "candidate_statuses_tenant_id_sort_index" ON "candidate_statuses" USING btree ("tenant_id","sort");--> statement-breakpoint
ALTER TABLE candidate_statuses ENABLE ROW LEVEL SECURITY;--> statement-breakpoint
ALTER TABLE candidate_statuses FORCE ROW LEVEL SECURITY;--> statement-breakpoint
CREATE POLICY tenant_isolation ON candidate_statuses
  USING (tenant_id = nullif(current_setting('app.tenant_id', true), '')::uuid)
  WITH CHECK (tenant_id = nullif(current_setting('app.tenant_id', true), '')::uuid);--> statement-breakpoint

-- ── 2. Колонки кандидата в `users` (`28` §3.2, `40` §3.2 — 11 из 16) ────────────────────
-- `kind` уже есть (0056, В-14). Здесь — остальные колонки `28`, кроме `vacancy_id` (PR-15).
ALTER TABLE "users" ADD COLUMN "candidate_state" text;--> statement-breakpoint
ALTER TABLE "users" ADD COLUMN "candidate_status_id" uuid;--> statement-breakpoint
ALTER TABLE "users" ADD COLUMN "source" text;--> statement-breakpoint
ALTER TABLE "users" ADD COLUMN "source_detail" text;--> statement-breakpoint
ALTER TABLE "users" ADD COLUMN "recruiter_id" uuid;--> statement-breakpoint
-- Право входа, а не дедлайн прохождения (`28` §3.2): дедлайн живёт в назначении (инвариант 1).
ALTER TABLE "users" ADD COLUMN "access_until" date;--> statement-breakpoint
ALTER TABLE "users" ADD COLUMN "comm_language" text DEFAULT 'uk' NOT NULL;--> statement-breakpoint
ALTER TABLE "users" ADD COLUMN "resume_asset_id" uuid;--> statement-breakpoint
ALTER TABLE "users" ADD COLUMN "converted_from_candidate_at" timestamp with time zone;--> statement-breakpoint
ALTER TABLE "users" ADD COLUMN "consent_given_at" timestamp with time zone;--> statement-breakpoint
ALTER TABLE "users" ADD COLUMN "consent_expires_at" date;--> statement-breakpoint

-- Канареечные кандидаты посева (0056 + seed.ts, слой 3 В-8) заведены до появления
-- `candidate_state` — иначе следующий констрейнт упал бы на уже существующих строках.
UPDATE "users" SET "candidate_state" = 'active' WHERE "kind" = 'candidate' AND "candidate_state" IS NULL;--> statement-breakpoint

ALTER TABLE "users" ADD CONSTRAINT "users_candidate_state_chk"
	CHECK ("candidate_state" IS NULL OR "candidate_state" IN ('active', 'hired', 'rejected', 'archived', 'withdrawn'));--> statement-breakpoint
-- Две оси согласованы на уровне схемы: у кандидата терминальное состояние есть всегда,
-- у сотрудника — никогда (`28` §3.2, §4.1). Сотрудник, пришедший через воронку, опознаётся
-- по `converted_from_candidate_at`, а не по остаточному `candidate_state`.
ALTER TABLE "users" ADD CONSTRAINT "users_candidate_coherence_chk"
	CHECK (("kind" = 'candidate' AND "candidate_state" IS NOT NULL)
	    OR ("kind" = 'employee' AND "candidate_state" IS NULL));--> statement-breakpoint
ALTER TABLE "users" ADD CONSTRAINT "users_candidate_source_chk"
	CHECK ("source" IS NULL OR "source" IN ('manual', 'vacancy_link', 'job_board', 'referral', 'import', 'api'));--> statement-breakpoint

-- Отложенный FK цикла 2 `40` §5 (0013) с именем из В-13. `on delete set null`: удаление
-- колонки канбана не уносит кандидата. Здесь, а не в миграции-развязке PR-15: справочник
-- создан выше в этом же файле, цикл DDL уже разорван порядком, и оставлять колонку без
-- ключа до PR-15 значило бы держать окно без ссылочной целостности без всякой пользы.
ALTER TABLE "users" ADD CONSTRAINT "users_candidate_status_id_fk" FOREIGN KEY ("candidate_status_id") REFERENCES "public"."candidate_statuses"("id") ON DELETE set null ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "users" ADD CONSTRAINT "users_recruiter_id_users_id_fk" FOREIGN KEY ("recruiter_id") REFERENCES "public"."users"("id") ON DELETE set null ON UPDATE no action;--> statement-breakpoint
-- Резюме — обычный файл `media_assets` с `origin='candidate_cv'` (0063, `34` §3.2):
-- отдельного хранилища у рекрутинга нет (`28` §3.7).
ALTER TABLE "users" ADD CONSTRAINT "users_resume_asset_id_media_assets_id_fk" FOREIGN KEY ("resume_asset_id") REFERENCES "public"."media_assets"("id") ON DELETE set null ON UPDATE no action;--> statement-breakpoint

CREATE INDEX "idx_users_tenant_kind" ON "users" USING btree ("tenant_id","kind");--> statement-breakpoint
CREATE INDEX "idx_users_tenant_candidate_status" ON "users" USING btree ("tenant_id","candidate_status_id") WHERE kind = 'candidate';--> statement-breakpoint
CREATE INDEX "idx_users_tenant_recruiter" ON "users" USING btree ("tenant_id","recruiter_id") WHERE kind = 'candidate';--> statement-breakpoint

-- ── 3. Оценки кандидата (`28` §3.4, `40` §5 0014) ───────────────────────────────────────
-- Четыре независимых вида оценки, не сводимые в один `score`: усреднение прячет случай
-- «блестящее тестовое, провальное собеседование», ради которого воронка и существует.
-- История сохраняется: новая оценка того же вида снимает `is_current` с предыдущей.
CREATE TABLE "candidate_scores" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	"updated_at" timestamp with time zone DEFAULT now() NOT NULL,
	"tenant_id" uuid NOT NULL,
	"candidate_id" uuid NOT NULL,
	"kind" text NOT NULL,
	"value_num" numeric(6, 2),
	"scale_id" uuid,
	"scale_level_id" uuid,
	"comment" text,
	"source_type" text,
	"source_id" uuid,
	"author_id" uuid,
	"is_current" boolean DEFAULT true NOT NULL,
	CONSTRAINT "candidate_scores_kind_chk" CHECK ("kind" IN ('manual', 'task', 'ai', 'recruiter')),
	CONSTRAINT "candidate_scores_value_chk" CHECK ("value_num" IS NOT NULL OR "scale_level_id" IS NOT NULL)
);
--> statement-breakpoint
ALTER TABLE "candidate_scores" ADD CONSTRAINT "candidate_scores_tenant_id_tenants_id_fk" FOREIGN KEY ("tenant_id") REFERENCES "public"."tenants"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "candidate_scores" ADD CONSTRAINT "candidate_scores_candidate_id_users_id_fk" FOREIGN KEY ("candidate_id") REFERENCES "public"."users"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "candidate_scores" ADD CONSTRAINT "candidate_scores_scale_id_scales_id_fk" FOREIGN KEY ("scale_id") REFERENCES "public"."scales"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "candidate_scores" ADD CONSTRAINT "candidate_scores_scale_level_id_scale_levels_id_fk" FOREIGN KEY ("scale_level_id") REFERENCES "public"."scale_levels"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "candidate_scores" ADD CONSTRAINT "candidate_scores_author_id_users_id_fk" FOREIGN KEY ("author_id") REFERENCES "public"."users"("id") ON DELETE set null ON UPDATE no action;--> statement-breakpoint
CREATE INDEX "idx_candidate_scores_tenant" ON "candidate_scores" USING btree ("tenant_id","candidate_id","kind");--> statement-breakpoint
-- Действующая оценка каждого вида ровно одна — индексом, а не проверкой в коде.
CREATE UNIQUE INDEX "uq_candidate_scores_current" ON "candidate_scores" USING btree ("tenant_id","candidate_id","kind") WHERE is_current;--> statement-breakpoint
ALTER TABLE candidate_scores ENABLE ROW LEVEL SECURITY;--> statement-breakpoint
ALTER TABLE candidate_scores FORCE ROW LEVEL SECURITY;--> statement-breakpoint
CREATE POLICY tenant_isolation ON candidate_scores
  USING (tenant_id = nullif(current_setting('app.tenant_id', true), '')::uuid)
  WITH CHECK (tenant_id = nullif(current_setting('app.tenant_id', true), '')::uuid);--> statement-breakpoint

-- ── 4. Комментарии рекрутеров (`28` §3.5) ───────────────────────────────────────────────
-- Кандидату не видны никогда, ни при какой `visibility`: это служебная переписка о человеке.
CREATE TABLE "candidate_comments" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	"updated_at" timestamp with time zone DEFAULT now() NOT NULL,
	"tenant_id" uuid NOT NULL,
	"candidate_id" uuid NOT NULL,
	"author_id" uuid NOT NULL,
	"body" text NOT NULL,
	"visibility" text DEFAULT 'recruiters' NOT NULL,
	"edited_at" timestamp with time zone,
	"deleted_at" timestamp with time zone,
	CONSTRAINT "candidate_comments_visibility_chk" CHECK ("visibility" IN ('recruiters', 'managers', 'all_staff')),
	CONSTRAINT "candidate_comments_body_chk" CHECK (length("body") BETWEEN 1 AND 4000)
);
--> statement-breakpoint
ALTER TABLE "candidate_comments" ADD CONSTRAINT "candidate_comments_tenant_id_tenants_id_fk" FOREIGN KEY ("tenant_id") REFERENCES "public"."tenants"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "candidate_comments" ADD CONSTRAINT "candidate_comments_candidate_id_users_id_fk" FOREIGN KEY ("candidate_id") REFERENCES "public"."users"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "candidate_comments" ADD CONSTRAINT "candidate_comments_author_id_users_id_fk" FOREIGN KEY ("author_id") REFERENCES "public"."users"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
CREATE INDEX "idx_candidate_comments_tenant" ON "candidate_comments" USING btree ("tenant_id","candidate_id","created_at" DESC);--> statement-breakpoint
ALTER TABLE candidate_comments ENABLE ROW LEVEL SECURITY;--> statement-breakpoint
ALTER TABLE candidate_comments FORCE ROW LEVEL SECURITY;--> statement-breakpoint
CREATE POLICY tenant_isolation ON candidate_comments
  USING (tenant_id = nullif(current_setting('app.tenant_id', true), '')::uuid)
  WITH CHECK (tenant_id = nullif(current_setting('app.tenant_id', true), '')::uuid);--> statement-breakpoint

-- ── 5. История колонок канбана (`28` §3.6) ──────────────────────────────────────────────
-- Хранит и воронку по времени («днів у статусі» считается отсюда, §7.11), и доказательство,
-- кто принял решение. `is_automatic` отделяет авто-переходы (§4.3) от решений человека.
CREATE TABLE "candidate_status_history" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	"updated_at" timestamp with time zone DEFAULT now() NOT NULL,
	"tenant_id" uuid NOT NULL,
	"candidate_id" uuid NOT NULL,
	"from_status_id" uuid,
	"to_status_id" uuid NOT NULL,
	"reason_code" text,
	"reason_text" text,
	"actor_id" uuid,
	"is_automatic" boolean DEFAULT false NOT NULL,
	-- CLAUDE.md п. 14: все журналы пишут технический контекст одинаково. В DDL `28` §3.6
	-- колонки нет, но правило сильнее краткости документа — тем же решением, что и
	-- `usage_events` в PR-09 (`40` §3.5). Таблица попадает в список журналов
	-- `tests/integration/schema-parity.spec.ts`.
	"request_context" jsonb
);
--> statement-breakpoint
ALTER TABLE "candidate_status_history" ADD CONSTRAINT "candidate_status_history_tenant_id_tenants_id_fk" FOREIGN KEY ("tenant_id") REFERENCES "public"."tenants"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "candidate_status_history" ADD CONSTRAINT "candidate_status_history_candidate_id_users_id_fk" FOREIGN KEY ("candidate_id") REFERENCES "public"."users"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "candidate_status_history" ADD CONSTRAINT "candidate_status_history_from_status_id_candidate_statuses_id_fk" FOREIGN KEY ("from_status_id") REFERENCES "public"."candidate_statuses"("id") ON DELETE set null ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "candidate_status_history" ADD CONSTRAINT "candidate_status_history_to_status_id_candidate_statuses_id_fk" FOREIGN KEY ("to_status_id") REFERENCES "public"."candidate_statuses"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "candidate_status_history" ADD CONSTRAINT "candidate_status_history_actor_id_users_id_fk" FOREIGN KEY ("actor_id") REFERENCES "public"."users"("id") ON DELETE set null ON UPDATE no action;--> statement-breakpoint
CREATE INDEX "idx_candidate_status_history_tenant" ON "candidate_status_history" USING btree ("tenant_id","candidate_id","created_at" DESC);--> statement-breakpoint
ALTER TABLE candidate_status_history ENABLE ROW LEVEL SECURITY;--> statement-breakpoint
ALTER TABLE candidate_status_history FORCE ROW LEVEL SECURITY;--> statement-breakpoint
CREATE POLICY tenant_isolation ON candidate_status_history
  USING (tenant_id = nullif(current_setting('app.tenant_id', true), '')::uuid)
  WITH CHECK (tenant_id = nullif(current_setting('app.tenant_id', true), '')::uuid);--> statement-breakpoint

-- ── 6. Шесть системных колонок воронки для уже заведённых тенантов (`28` §3.3) ──────────
-- Новые тенанты получают их из ensureTenantDefaults (server/db/tenantDefaults.ts): на чистой
-- БД тенантов ещё нет и вставка отсюда была бы пустой. Здесь — догоняющая вставка теми же
-- значениями, идемпотентная по (tenant_id, code).
INSERT INTO candidate_statuses (tenant_id, code, name_uk, name_en, color, sort, is_system, maps_to)
SELECT t.id, s.code, s.name_uk, s.name_en, s.color, s.sort, true, s.maps_to
FROM tenants t
CROSS JOIN (VALUES
	('new',         'Не розпочали', 'Not started',  'ink',   0, 'active'),
	('in_progress', 'Проходять',    'In progress',  'teal',  1, 'active'),
	('on_review',   'На перевірці', 'On review',    'sun',   2, 'active'),
	('approved',    'Схвалені',     'Approved',     'teal',  3, 'active'),
	('doubt',       'Під сумнівом', 'In doubt',     'sun',   4, 'active'),
	('rejected',    'Відхилені',    'Rejected',     'coral', 5, 'rejected')
) AS s(code, name_uk, name_en, color, sort, maps_to)
ON CONFLICT (tenant_id, code) DO NOTHING;
