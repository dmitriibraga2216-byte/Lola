-- docs/v2/45-plan.md PR-09 · docs/v2/35-billing-limits.md §3.3, §3.5, §3.6, §7.1, §7.5, §7.9 ·
-- docs/v2/44-decisions.md В-16 · docs/v2/39-patches.md П-25.2
--
-- Учёт потребления по одиннадцати осям: счётчики периода (`usage_counters`), журнал расхода
-- (`usage_events`), открытые предупреждения баннера (`limit_notices`) и восемь колонок
-- суточного среза (`alter tenant_usage`).
--
-- Лимит здесь не считается ни разу: формула одна и живёт в `effectiveLimits()` (PR-08,
-- docs/v2/35 §7.3, решение В-5). Счётчик хранит только ФАКТ и снимок лимита на момент
-- открытия периода — чтобы смена тарифа в середине месяца не переписывала задним числом уже
-- потраченное (§7.3, последний абзац).
--
-- Номер 0061, а не 0060: 0060 зарезервирована за параллельным PR-07 (`45` §5, правило
-- «следующий свободный номер»); `when` в _journal.json взят с запасом над 0059.

-- ── 1. usage_counters — счётчик периода, реальное время (§3.5) ───────────────────────────
-- PK (tenant_id, axis, period_start): один счётчик на ось и период, вставка идемпотентна.
-- `limit_snapshot` null = «без обмежень» на момент открытия периода (§7.3).
CREATE TABLE "usage_counters" (
	"tenant_id" uuid NOT NULL,
	"axis" text NOT NULL,
	"period_start" date NOT NULL,
	"period_end" date NOT NULL,
	"used" bigint DEFAULT 0 NOT NULL,
	"limit_snapshot" bigint,
	"updated_at" timestamp with time zone DEFAULT now() NOT NULL,
	CONSTRAINT "usage_counters_tenant_id_axis_period_start_pk" PRIMARY KEY("tenant_id","axis","period_start"),
	-- Ось — одна из одиннадцати docs/v2/35 §7.1 (shared/enums.ts LIMIT_AXES). Служебного
	-- `ai_term` здесь нет: это срок ИИ, а не ось потребления (PR-08, docs/28 §28.11 п. 3).
	CONSTRAINT "usage_counters_axis_check" CHECK ("axis" IN (
		'users_active', 'candidates_active', 'storage_bytes', 'ai_generate_ops', 'ai_review_ops',
		'ai_interview_ops', 'sms_out', 'telegram_out', 'integrations_active', 'api_rate_rpm',
		'export_rows')),
	CONSTRAINT "usage_counters_period_check" CHECK ("period_end" >= "period_start")
);--> statement-breakpoint
ALTER TABLE "usage_counters" ADD CONSTRAINT "usage_counters_tenant_id_tenants_id_fk" FOREIGN KEY ("tenant_id") REFERENCES "public"."tenants"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
-- Индекс §3.5 дословно; полный tenant-first индекс даёт сам PK (контрактный тест v2-contract-02)
CREATE INDEX "usage_counters_axis_idx" ON "usage_counters" USING btree ("tenant_id","axis","period_end" DESC);--> statement-breakpoint
ALTER TABLE usage_counters ENABLE ROW LEVEL SECURITY;--> statement-breakpoint
ALTER TABLE usage_counters FORCE ROW LEVEL SECURITY;--> statement-breakpoint
CREATE POLICY tenant_isolation ON usage_counters
  USING (tenant_id = nullif(current_setting('app.tenant_id', true), '')::uuid)
  WITH CHECK (tenant_id = nullif(current_setting('app.tenant_id', true), '')::uuid);--> statement-breakpoint
COMMENT ON COLUMN "usage_counters"."limit_snapshot" IS 'Снимок эффективного лимита на момент открытия периода (docs/v2/35 §7.3); null = без обмежень';--> statement-breakpoint

-- ── 2. usage_events — журнал расхода, хранение 400 дней (§3.5, §9 «Журнал ШІ-операцій») ──
-- `request_context` сверх §3.5: CLAUDE.md п. 14 — все журналы пишут ip/geo/user_agent
-- одинаково (docs/28, решение PR-09). Перечень `ref_kind` — ровно шесть значений документа:
-- журнал ведут только измеряемые операции; моментальные оси (люди, кандидаты, интеграции)
-- строки расхода не создают, их счётчик сходится пересчётом (docs/v2/35 §7.1, §7.5).
CREATE TABLE "usage_events" (
	"id" bigserial PRIMARY KEY NOT NULL,
	"tenant_id" uuid NOT NULL,
	"axis" text NOT NULL,
	"delta" bigint NOT NULL,
	"ref_kind" text NOT NULL,
	"ref_id" uuid,
	"actor_user_id" uuid,
	"meta" jsonb DEFAULT '{}'::jsonb NOT NULL,
	"request_context" jsonb,
	"occurred_at" timestamp with time zone DEFAULT now() NOT NULL,
	CONSTRAINT "usage_events_axis_check" CHECK ("axis" IN (
		'users_active', 'candidates_active', 'storage_bytes', 'ai_generate_ops', 'ai_review_ops',
		'ai_interview_ops', 'sms_out', 'telegram_out', 'integrations_active', 'api_rate_rpm',
		'export_rows')),
	CONSTRAINT "usage_events_ref_kind_check" CHECK ("ref_kind" IN (
		'ai_generation', 'ai_review', 'ai_interview', 'sms', 'upload', 'export'))
);--> statement-breakpoint
ALTER TABLE "usage_events" ADD CONSTRAINT "usage_events_tenant_id_tenants_id_fk" FOREIGN KEY ("tenant_id") REFERENCES "public"."tenants"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
CREATE INDEX "usage_events_axis_idx" ON "usage_events" USING btree ("tenant_id","axis","occurred_at" DESC);--> statement-breakpoint
ALTER TABLE usage_events ENABLE ROW LEVEL SECURITY;--> statement-breakpoint
ALTER TABLE usage_events FORCE ROW LEVEL SECURITY;--> statement-breakpoint
CREATE POLICY tenant_isolation ON usage_events
  USING (tenant_id = nullif(current_setting('app.tenant_id', true), '')::uuid)
  WITH CHECK (tenant_id = nullif(current_setting('app.tenant_id', true), '')::uuid);--> statement-breakpoint

-- ── 3. limit_notices — открытые предупреждения баннера (§3.5, §7.9) ─────────────────────
-- Частичный уникальный индекс §3.5 держит инвариант «одно открытое предупреждение на ось и
-- уровень» (условие выхода PR-09); рядом — полный tenant-first индекс, без него частичный
-- не покрывает список баннера (контрактный тест v2-contract-02).
CREATE TABLE "limit_notices" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"tenant_id" uuid NOT NULL,
	"axis" text NOT NULL,
	"level" text NOT NULL,
	"value_at_raise" bigint NOT NULL,
	"limit_at_raise" bigint,
	"resolved_at" timestamp with time zone,
	"dismissed_by" uuid,
	"dismissed_until" timestamp with time zone,
	"raised_at" timestamp with time zone DEFAULT now() NOT NULL,
	CONSTRAINT "limit_notices_axis_check" CHECK ("axis" IN (
		'users_active', 'candidates_active', 'storage_bytes', 'ai_generate_ops', 'ai_review_ops',
		'ai_interview_ops', 'sms_out', 'telegram_out', 'integrations_active', 'api_rate_rpm',
		'export_rows')),
	CONSTRAINT "limit_notices_level_check" CHECK ("level" IN ('warn', 'exceeded'))
);--> statement-breakpoint
ALTER TABLE "limit_notices" ADD CONSTRAINT "limit_notices_tenant_id_tenants_id_fk" FOREIGN KEY ("tenant_id") REFERENCES "public"."tenants"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
CREATE UNIQUE INDEX "limit_notices_open_uidx" ON "limit_notices" USING btree ("tenant_id","axis","level") WHERE "resolved_at" is null;--> statement-breakpoint
CREATE INDEX "limit_notices_tenant_id_raised_at_index" ON "limit_notices" USING btree ("tenant_id","raised_at" DESC);--> statement-breakpoint
ALTER TABLE limit_notices ENABLE ROW LEVEL SECURITY;--> statement-breakpoint
ALTER TABLE limit_notices FORCE ROW LEVEL SECURITY;--> statement-breakpoint
CREATE POLICY tenant_isolation ON limit_notices
  USING (tenant_id = nullif(current_setting('app.tenant_id', true), '')::uuid)
  WITH CHECK (tenant_id = nullif(current_setting('app.tenant_id', true), '')::uuid);--> statement-breakpoint

-- ── 4. tenant_usage: восемь колонок суточного среза (§3.3) ───────────────────────────────
-- `plan_code`, а не `plan_id uuid references plans(id)`: колонки `id` у тарифа нет (В-5,
-- то же исправление, что у plan_prices и tenant_payments в §3.4). Решение — docs/28 §28.12.
ALTER TABLE "tenant_usage" ADD COLUMN "plan_code" text;--> statement-breakpoint
ALTER TABLE "tenant_usage" ADD CONSTRAINT "tenant_usage_plan_code_plans_code_fk" FOREIGN KEY ("plan_code") REFERENCES "public"."plans"("code") ON DELETE set null ON UPDATE cascade;--> statement-breakpoint
ALTER TABLE "tenant_usage" ADD COLUMN "candidates_active" integer DEFAULT 0 NOT NULL;--> statement-breakpoint
-- Разбивка по 10 категориям треков docs/05-tracks.md плюс `other` (снято с /storage эталона)
ALTER TABLE "tenant_usage" ADD COLUMN "storage_by_category" jsonb DEFAULT '{}'::jsonb NOT NULL;--> statement-breakpoint
-- Три ИИ-оси одним объектом: {ai_generate_ops, ai_review_ops, ai_interview_ops}
ALTER TABLE "tenant_usage" ADD COLUMN "ai_ops" jsonb DEFAULT '{}'::jsonb NOT NULL;--> statement-breakpoint
-- sms_out — расход оси за биллинговый период; прежняя sms_month (календарный месяц) остаётся
-- нетронутой: её читает экран «Статистика використання» и панель оператора (docs/28 §28.12)
ALTER TABLE "tenant_usage" ADD COLUMN "sms_out" integer DEFAULT 0 NOT NULL;--> statement-breakpoint
ALTER TABLE "tenant_usage" ADD COLUMN "telegram_out" integer DEFAULT 0 NOT NULL;--> statement-breakpoint
ALTER TABLE "tenant_usage" ADD COLUMN "integrations_active" integer DEFAULT 0 NOT NULL;--> statement-breakpoint
-- `axes` — расширение без миграции (§3.3): нетарифная ось живёт здесь и получает колонку,
-- только когда признана тарифной. Сегодня это telegram_out — она наблюдается, но не тарифицируется
ALTER TABLE "tenant_usage" ADD COLUMN "axes" jsonb DEFAULT '{}'::jsonb NOT NULL;--> statement-breakpoint
COMMENT ON COLUMN "tenant_usage"."sms_month" IS 'SMS с начала календарного месяца (docs/24 §4.4.1); расход оси sms_out за биллинговый период — колонка sms_out';
