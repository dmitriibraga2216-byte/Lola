-- docs/v2/45-plan.md PR-15 · docs/v2/29-vacancies.md §3.1–§3.4 · docs/v2/40-data-model-delta.md §2
-- · docs/v2/44-decisions.md В-13 (порядок создания и имена отложенных FK).
--
-- Вакансия — описание открытой позиции, порождающее публичную ссылку на отбор. Инвариант 1
-- документа `29` (он же правило 11 корневого CLAUDE.md): **вакансия не носитель правил
-- прохождения**. Она указывает, какой курс назначить откликнувшемуся и с какими параметрами,
-- но параметры лежат в ней как шаблон (`assignment_template`), а применяются созданием
-- обычной `assignments`. Поэтому в этом файле нет ни одной колонки `attempts`, `pass_score`,
-- `due_at`, `time_limit`: всё это живёт внутри jsonb-шаблона и попадает в назначение через
-- единственный фильтр `stageParamsFor()` (PR-06).
--
-- Порядок внутри файла (`29` §3.1 [решение]): `vacancy_templates` создаётся раньше
-- `vacancies` — на неё смотрит `vacancies.template_id`. Цикл «кандидаты ↔ вакансии» этим
-- порядком не снимается: `vacancies.recruiter_id` смотрит на `users`, а `users.vacancy_id`
-- обязан смотреть назад на `vacancies`. Колонку и её ключ добавляет вторая миграция
-- `0072_v2_users_vacancy_fk` — развязка В-13, единственный способ разорвать настоящий цикл DDL.

-- ── 1. Шаблоны вакансий (`29` §3.4) ─────────────────────────────────────────────────────
-- Самостоятельная сущность, а не вакансия-черновик: иначе шаблоны попали бы в реестр
-- вакансий, в отчёты воронки и получили бы публичные ссылки. `criteria` и `languages`
-- вложены в строку, чтобы применение шаблона шло одной транзакцией.
CREATE TABLE "vacancy_templates" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	"updated_at" timestamp with time zone DEFAULT now() NOT NULL,
	"tenant_id" uuid NOT NULL,
	"name" text NOT NULL,
	"description" text,
	"payload" jsonb DEFAULT '{}'::jsonb NOT NULL,
	"criteria" jsonb DEFAULT '[]'::jsonb NOT NULL,
	"languages" jsonb DEFAULT '[]'::jsonb NOT NULL,
	"usage_count" integer DEFAULT 0 NOT NULL,
	"is_active" boolean DEFAULT true NOT NULL,
	"created_by" uuid,
	CONSTRAINT "vacancy_templates_tenant_id_name_unique" UNIQUE("tenant_id","name"),
	CONSTRAINT "vacancy_templates_name_chk" CHECK (length("name") BETWEEN 3 AND 120)
);
--> statement-breakpoint
ALTER TABLE "vacancy_templates" ADD CONSTRAINT "vacancy_templates_tenant_id_tenants_id_fk" FOREIGN KEY ("tenant_id") REFERENCES "public"."tenants"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "vacancy_templates" ADD CONSTRAINT "vacancy_templates_created_by_users_id_fk" FOREIGN KEY ("created_by") REFERENCES "public"."users"("id") ON DELETE set null ON UPDATE no action;--> statement-breakpoint
CREATE INDEX "idx_vacancy_templates_tenant" ON "vacancy_templates" USING btree ("tenant_id","is_active","name");--> statement-breakpoint
ALTER TABLE vacancy_templates ENABLE ROW LEVEL SECURITY;--> statement-breakpoint
ALTER TABLE vacancy_templates FORCE ROW LEVEL SECURITY;--> statement-breakpoint
CREATE POLICY tenant_isolation ON vacancy_templates
  USING (tenant_id = nullif(current_setting('app.tenant_id', true), '')::uuid)
  WITH CHECK (tenant_id = nullif(current_setting('app.tenant_id', true), '')::uuid);--> statement-breakpoint

-- ── 2. Вакансия (`29` §3.1) ─────────────────────────────────────────────────────────────
-- `vacancies_public_chk` — правило эталона «без курса и точки ссылка не создаётся», вынесенное
-- в констрейнт БД, а не оставленное форме (`29` §3.1 [решение], §7.1, §14): ссылка без
-- назначаемого курса — это отклик, который некуда девать. Констрейнт закрывает критерий
-- приёмки `29` §13 к. 1 на уровне схемы: даже прямой UPDATE мимо сервиса не создаст ссылку.
CREATE TABLE "vacancies" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	"updated_at" timestamp with time zone DEFAULT now() NOT NULL,
	"tenant_id" uuid NOT NULL,
	"title" text NOT NULL,
	"state" text DEFAULT 'draft' NOT NULL,
	"category_id" uuid,
	"recruiter_id" uuid,
	"course_id" uuid,
	"course_version_id" uuid,
	"location_id" uuid,
	"org_unit_id" uuid,
	"position_id" uuid,
	"description_html" text,
	"requirements_html" text,
	"duties_html" text,
	"extra_html" text,
	"ai_blocks" jsonb DEFAULT '{}'::jsonb NOT NULL,
	"employment_type" text,
	"work_format" text,
	"country_code" char(2),
	"city" text,
	"experience_level" text,
	"education_level" text,
	"salary_from" numeric(12, 2),
	"salary_to" numeric(12, 2),
	"salary_currency" char(3) DEFAULT 'UAH' NOT NULL,
	"salary_visible" boolean DEFAULT false NOT NULL,
	-- Шаблон параметров назначения, а не правила прохождения (`29` §3.5, инвариант 1).
	"assignment_template" jsonb DEFAULT '{}'::jsonb NOT NULL,
	"public_token" text,
	"public_enabled" boolean DEFAULT false NOT NULL,
	"public_apply_otp" boolean DEFAULT true NOT NULL,
	"apply_daily_cap" integer DEFAULT 200 NOT NULL,
	"source_budget" numeric(12, 2),
	"template_id" uuid,
	"published_at" timestamp with time zone,
	"closed_at" timestamp with time zone,
	"close_reason" text,
	"created_by" uuid,
	CONSTRAINT "vacancies_tenant_id_public_token_unique" UNIQUE("tenant_id","public_token"),
	CONSTRAINT "vacancies_state_chk" CHECK ("state" IN ('draft', 'published', 'paused', 'closed', 'archived')),
	CONSTRAINT "vacancies_employment_chk" CHECK ("employment_type" IS NULL OR "employment_type" IN ('full_time', 'part_time', 'shift', 'temporary', 'internship', 'contract')),
	CONSTRAINT "vacancies_format_chk" CHECK ("work_format" IS NULL OR "work_format" IN ('on_site', 'hybrid', 'remote')),
	CONSTRAINT "vacancies_experience_chk" CHECK ("experience_level" IS NULL OR "experience_level" IN ('none', 'under_1y', '1_3y', '3_5y', 'over_5y')),
	CONSTRAINT "vacancies_education_chk" CHECK ("education_level" IS NULL OR "education_level" IN ('none', 'secondary', 'vocational', 'incomplete_higher', 'higher')),
	CONSTRAINT "vacancies_close_reason_chk" CHECK ("close_reason" IS NULL OR "close_reason" IN ('filled', 'no_need', 'budget', 'postponed', 'other')),
	CONSTRAINT "vacancies_salary_chk" CHECK ("salary_from" IS NULL OR "salary_to" IS NULL OR "salary_from" <= "salary_to"),
	CONSTRAINT "vacancies_title_chk" CHECK (length("title") BETWEEN 3 AND 200),
	CONSTRAINT "vacancies_cap_chk" CHECK ("apply_daily_cap" BETWEEN 10 AND 5000),
	CONSTRAINT "vacancies_public_chk" CHECK (NOT "public_enabled" OR ("course_id" IS NOT NULL AND "location_id" IS NOT NULL AND "public_token" IS NOT NULL))
);
--> statement-breakpoint
ALTER TABLE "vacancies" ADD CONSTRAINT "vacancies_tenant_id_tenants_id_fk" FOREIGN KEY ("tenant_id") REFERENCES "public"."tenants"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "vacancies" ADD CONSTRAINT "vacancies_category_id_course_categories_id_fk" FOREIGN KEY ("category_id") REFERENCES "public"."course_categories"("id") ON DELETE set null ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "vacancies" ADD CONSTRAINT "vacancies_recruiter_id_users_id_fk" FOREIGN KEY ("recruiter_id") REFERENCES "public"."users"("id") ON DELETE set null ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "vacancies" ADD CONSTRAINT "vacancies_course_id_courses_id_fk" FOREIGN KEY ("course_id") REFERENCES "public"."courses"("id") ON DELETE set null ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "vacancies" ADD CONSTRAINT "vacancies_course_version_id_course_versions_id_fk" FOREIGN KEY ("course_version_id") REFERENCES "public"."course_versions"("id") ON DELETE set null ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "vacancies" ADD CONSTRAINT "vacancies_location_id_locations_id_fk" FOREIGN KEY ("location_id") REFERENCES "public"."locations"("id") ON DELETE set null ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "vacancies" ADD CONSTRAINT "vacancies_org_unit_id_org_units_id_fk" FOREIGN KEY ("org_unit_id") REFERENCES "public"."org_units"("id") ON DELETE set null ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "vacancies" ADD CONSTRAINT "vacancies_position_id_positions_id_fk" FOREIGN KEY ("position_id") REFERENCES "public"."positions"("id") ON DELETE set null ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "vacancies" ADD CONSTRAINT "vacancies_template_id_vacancy_templates_id_fk" FOREIGN KEY ("template_id") REFERENCES "public"."vacancy_templates"("id") ON DELETE set null ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "vacancies" ADD CONSTRAINT "vacancies_created_by_users_id_fk" FOREIGN KEY ("created_by") REFERENCES "public"."users"("id") ON DELETE set null ON UPDATE no action;--> statement-breakpoint
CREATE INDEX "idx_vacancies_tenant" ON "vacancies" USING btree ("tenant_id","state","updated_at" DESC);--> statement-breakpoint
CREATE INDEX "idx_vacancies_tenant_location" ON "vacancies" USING btree ("tenant_id","location_id");--> statement-breakpoint
CREATE INDEX "idx_vacancies_tenant_recruiter" ON "vacancies" USING btree ("tenant_id","recruiter_id");--> statement-breakpoint
-- Токен уникален **глобально**, а не в тенанте: публичная ссылка приходит без сессии, и
-- тенант выводится из самого токена (`29` §10 [решение], П-04). Два тенанта с одинаковым
-- токеном сделали бы этот вывод неоднозначным.
CREATE UNIQUE INDEX "uq_vacancies_public_token" ON "vacancies" USING btree ("public_token") WHERE public_token IS NOT NULL;--> statement-breakpoint
ALTER TABLE vacancies ENABLE ROW LEVEL SECURITY;--> statement-breakpoint
ALTER TABLE vacancies FORCE ROW LEVEL SECURITY;--> statement-breakpoint
CREATE POLICY tenant_isolation ON vacancies
  USING (tenant_id = nullif(current_setting('app.tenant_id', true), '')::uuid)
  WITH CHECK (tenant_id = nullif(current_setting('app.tenant_id', true), '')::uuid);--> statement-breakpoint

-- ── 3. Языки вакансии (`29` §3.2, Г-29.4) ───────────────────────────────────────────────
-- Пара «язык + уровень» плюс `is_required`: «англійська B2 обов'язково, польська A2 бажано» —
-- обычное требование для линейного персонала, а без флага оно невыразимо.
CREATE TABLE "vacancy_languages" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	"updated_at" timestamp with time zone DEFAULT now() NOT NULL,
	"tenant_id" uuid NOT NULL,
	"vacancy_id" uuid NOT NULL,
	"lang_code" text NOT NULL,
	"level" text NOT NULL,
	"is_required" boolean DEFAULT true NOT NULL,
	"sort" integer DEFAULT 0 NOT NULL,
	CONSTRAINT "vacancy_languages_tenant_id_vacancy_id_lang_code_unique" UNIQUE("tenant_id","vacancy_id","lang_code"),
	CONSTRAINT "vacancy_languages_level_chk" CHECK ("level" IN ('a1', 'a2', 'b1', 'b2', 'c1', 'c2', 'native'))
);
--> statement-breakpoint
ALTER TABLE "vacancy_languages" ADD CONSTRAINT "vacancy_languages_tenant_id_tenants_id_fk" FOREIGN KEY ("tenant_id") REFERENCES "public"."tenants"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "vacancy_languages" ADD CONSTRAINT "vacancy_languages_vacancy_id_vacancies_id_fk" FOREIGN KEY ("vacancy_id") REFERENCES "public"."vacancies"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
CREATE INDEX "idx_vacancy_languages_tenant" ON "vacancy_languages" USING btree ("tenant_id","vacancy_id","sort");--> statement-breakpoint
ALTER TABLE vacancy_languages ENABLE ROW LEVEL SECURITY;--> statement-breakpoint
ALTER TABLE vacancy_languages FORCE ROW LEVEL SECURITY;--> statement-breakpoint
CREATE POLICY tenant_isolation ON vacancy_languages
  USING (tenant_id = nullif(current_setting('app.tenant_id', true), '')::uuid)
  WITH CHECK (tenant_id = nullif(current_setting('app.tenant_id', true), '')::uuid);--> statement-breakpoint

-- ── 4. Критерии оценки кандидата (`29` §3.3) ────────────────────────────────────────────
-- Критерии — **рамка человеческого решения, а не правило прохождения**: они ничего не
-- блокируют и не влияют ни на `enrollments`, ни на `attempts`. Единственный их выход —
-- свёртка в одну строку `candidate_scores` с `kind = 'recruiter'` (`28` §3.4).
-- `is_critical` не запрещает найм: минимальный балл даёт предупреждение, а жёсткий
-- стоп-фактор был бы автоматизированным решением о человеке (инвариант 18, `28` §7.4).
CREATE TABLE "vacancy_criteria" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	"updated_at" timestamp with time zone DEFAULT now() NOT NULL,
	"tenant_id" uuid NOT NULL,
	"vacancy_id" uuid NOT NULL,
	"name" text NOT NULL,
	"description" text,
	"weight" numeric(5, 2) DEFAULT '1' NOT NULL,
	"scale_min" numeric(6, 2) DEFAULT '0' NOT NULL,
	"scale_max" numeric(6, 2) DEFAULT '5' NOT NULL,
	"is_critical" boolean DEFAULT false NOT NULL,
	"origin" text DEFAULT 'manual' NOT NULL,
	"sort" integer DEFAULT 0 NOT NULL,
	"is_active" boolean DEFAULT true NOT NULL,
	CONSTRAINT "vacancy_criteria_origin_chk" CHECK ("origin" IN ('manual', 'ai', 'template')),
	CONSTRAINT "vacancy_criteria_weight_chk" CHECK ("weight" > 0 AND "weight" <= 100),
	CONSTRAINT "vacancy_criteria_scale_chk" CHECK ("scale_max" > "scale_min"),
	CONSTRAINT "vacancy_criteria_name_chk" CHECK (length("name") BETWEEN 2 AND 120)
);
--> statement-breakpoint
ALTER TABLE "vacancy_criteria" ADD CONSTRAINT "vacancy_criteria_tenant_id_tenants_id_fk" FOREIGN KEY ("tenant_id") REFERENCES "public"."tenants"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "vacancy_criteria" ADD CONSTRAINT "vacancy_criteria_vacancy_id_vacancies_id_fk" FOREIGN KEY ("vacancy_id") REFERENCES "public"."vacancies"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
CREATE INDEX "idx_vacancy_criteria_tenant" ON "vacancy_criteria" USING btree ("tenant_id","vacancy_id","sort");--> statement-breakpoint
ALTER TABLE vacancy_criteria ENABLE ROW LEVEL SECURITY;--> statement-breakpoint
ALTER TABLE vacancy_criteria FORCE ROW LEVEL SECURITY;--> statement-breakpoint
CREATE POLICY tenant_isolation ON vacancy_criteria
  USING (tenant_id = nullif(current_setting('app.tenant_id', true), '')::uuid)
  WITH CHECK (tenant_id = nullif(current_setting('app.tenant_id', true), '')::uuid);--> statement-breakpoint

-- ── 5. Баллы по критериям (`29` §3.3) ───────────────────────────────────────────────────
-- Балл одного автора по одному критерию один: `unique (tenant_id, candidate_id, criterion_id,
-- author_id)`. Второй рекрутер оценивает того же кандидата своей строкой, свёртка §3.3
-- считается по всем авторам.
CREATE TABLE "vacancy_criterion_scores" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	"updated_at" timestamp with time zone DEFAULT now() NOT NULL,
	"tenant_id" uuid NOT NULL,
	"candidate_id" uuid NOT NULL,
	"criterion_id" uuid NOT NULL,
	"value_num" numeric(6, 2) NOT NULL,
	"comment" text,
	"author_id" uuid NOT NULL,
	CONSTRAINT "vacancy_criterion_scores_unique" UNIQUE("tenant_id","candidate_id","criterion_id","author_id")
);
--> statement-breakpoint
ALTER TABLE "vacancy_criterion_scores" ADD CONSTRAINT "vacancy_criterion_scores_tenant_id_tenants_id_fk" FOREIGN KEY ("tenant_id") REFERENCES "public"."tenants"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "vacancy_criterion_scores" ADD CONSTRAINT "vacancy_criterion_scores_candidate_id_users_id_fk" FOREIGN KEY ("candidate_id") REFERENCES "public"."users"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "vacancy_criterion_scores" ADD CONSTRAINT "vacancy_criterion_scores_criterion_id_vacancy_criteria_id_fk" FOREIGN KEY ("criterion_id") REFERENCES "public"."vacancy_criteria"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "vacancy_criterion_scores" ADD CONSTRAINT "vacancy_criterion_scores_author_id_users_id_fk" FOREIGN KEY ("author_id") REFERENCES "public"."users"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
CREATE INDEX "idx_vacancy_criterion_scores_tenant" ON "vacancy_criterion_scores" USING btree ("tenant_id","candidate_id");--> statement-breakpoint
ALTER TABLE vacancy_criterion_scores ENABLE ROW LEVEL SECURITY;--> statement-breakpoint
ALTER TABLE vacancy_criterion_scores FORCE ROW LEVEL SECURITY;--> statement-breakpoint
CREATE POLICY tenant_isolation ON vacancy_criterion_scores
  USING (tenant_id = nullif(current_setting('app.tenant_id', true), '')::uuid)
  WITH CHECK (tenant_id = nullif(current_setting('app.tenant_id', true), '')::uuid);
