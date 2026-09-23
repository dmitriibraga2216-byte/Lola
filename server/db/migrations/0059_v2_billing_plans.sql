-- docs/v2/45-plan.md PR-08 · docs/v2/35-billing-limits.md §3.1–3.6, §7.1, §7.3 ·
-- docs/v2/44-decisions.md В-5 · docs/v2/39-patches.md П-25.1 (в редакции «шесть осей → одиннадцать»)
--
-- Платформенный слой тарифа и одиннадцать осей лимита ЯВНЫМИ колонками (В-5, вариант C):
-- колонка — у оси, по которой выставляется счёт; jsonb (`tenant_usage.axes`, PR-09) — только
-- у нетарифной `telegram_out`. Причина в В-5: пять мест сравнивают потребление с лимитом, и
-- опечатка в ключе jsonb вернула бы null, то есть «без обмежень» — тихо снятый лимит в счёте.
--
-- Номер 0059, а не 0058: 0058 зарезервирована за параллельным PR-06 (`45` §5, правило
-- «следующий свободный номер»); `when` в _journal.json взят с запасом над 0057.

-- ── 1. plans: восемь колонок пакета (§3.1). PK остаётся `code` — колонки `id` у тарифа нет ──
-- (В-5: на `plans.code` уже ссылается `tenants.plan`, второй идентификатор тарифа означал бы
-- два способа сослаться на тариф и вопрос «какой правильный» в каждом новом запросе.)
ALTER TABLE "plans" ADD COLUMN "title_uk" text;--> statement-breakpoint
ALTER TABLE "plans" ADD COLUMN "tier" smallint DEFAULT 0 NOT NULL;--> statement-breakpoint
ALTER TABLE "plans" ADD COLUMN "ai_included" boolean DEFAULT true NOT NULL;--> statement-breakpoint
ALTER TABLE "plans" ADD COLUMN "ai_term_days" integer;--> statement-breakpoint
ALTER TABLE "plans" ADD COLUMN "addons_allowed" text[] DEFAULT '{}' NOT NULL;--> statement-breakpoint
ALTER TABLE "plans" ADD COLUMN "is_active" boolean DEFAULT true NOT NULL;--> statement-breakpoint
ALTER TABLE "plans" ADD COLUMN "valid_from" date DEFAULT current_date NOT NULL;--> statement-breakpoint
ALTER TABLE "plans" ADD COLUMN "valid_to" date;--> statement-breakpoint

-- Пять новых осей лимита в тарифе рядом с существующими max_* (В-5, таблица раскладки осей).
-- `api_rate_rpm` и `integrations_active` колонки в тарифе не получают: их лимит и сегодня
-- живёт только в `tenant_limits` (докс/33 D-055), умолчание api — DEFAULT_API_PER_MINUTE.
ALTER TABLE "plans" ADD COLUMN "max_candidates" integer;--> statement-breakpoint
ALTER TABLE "plans" ADD COLUMN "max_ai_generate_ops" integer;--> statement-breakpoint
ALTER TABLE "plans" ADD COLUMN "max_ai_review_ops" integer;--> statement-breakpoint
ALTER TABLE "plans" ADD COLUMN "max_ai_interview_ops" integer;--> statement-breakpoint
ALTER TABLE "plans" ADD COLUMN "max_export_rows" integer;--> statement-breakpoint
COMMENT ON COLUMN "plans"."max_users" IS 'Ось users_active (docs/v2/35 §7.1): активные сотрудники, kind = employee';--> statement-breakpoint
COMMENT ON COLUMN "plans"."max_storage_gb" IS 'Ось storage_bytes: лимит в ГБ, потребление в байтах (docs/v2/44 В-5)';--> statement-breakpoint

-- ── 2. plan_prices — цены тарифа (§3.4). Платформенная таблица, вне RLS ──────────────────
-- FK на `plan_code`, а не `plan_id uuid`: у `plans` нет колонки `id` (В-5, исправление §3.4).
CREATE TABLE "plan_prices" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	"updated_at" timestamp with time zone DEFAULT now() NOT NULL,
	"plan_code" text NOT NULL,
	"billing_period" text NOT NULL,
	"currency" char(3) DEFAULT 'EUR' NOT NULL,
	"amount_minor" bigint NOT NULL,
	"valid_from" date DEFAULT current_date NOT NULL,
	"valid_to" date,
	CONSTRAINT "plan_prices_billing_period_check" CHECK ("billing_period" IN ('month', 'year')),
	-- Цена в минорных единицах (центах): деньги целым числом, без плавающей точки (§3.4)
	CONSTRAINT "plan_prices_amount_minor_check" CHECK ("amount_minor" >= 0),
	CONSTRAINT "plan_prices_plan_code_billing_period_currency_valid_from_unique" UNIQUE("plan_code","billing_period","currency","valid_from")
);--> statement-breakpoint
ALTER TABLE "plan_prices" ADD CONSTRAINT "plan_prices_plan_code_plans_code_fk" FOREIGN KEY ("plan_code") REFERENCES "public"."plans"("code") ON DELETE cascade ON UPDATE cascade;--> statement-breakpoint
CREATE INDEX "plan_prices_plan_code_valid_from_index" ON "plan_prices" USING btree ("plan_code","valid_from" DESC);--> statement-breakpoint

-- ── 3. plan_addons — каталог опций (§3.4). Платформенная таблица, вне RLS ────────────────
CREATE TABLE "plan_addons" (
	"code" text PRIMARY KEY NOT NULL,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	"updated_at" timestamp with time zone DEFAULT now() NOT NULL,
	"name" text NOT NULL,
	"axis" text NOT NULL,
	"unit_step" bigint NOT NULL,
	"term" text NOT NULL,
	"is_public" boolean DEFAULT true NOT NULL,
	"sort" integer DEFAULT 0 NOT NULL,
	-- Ось — одна из одиннадцати (docs/v2/35 §7.1, shared/enums.ts LIMIT_AXES) либо служебное
	-- `ai_term`: у опции `ai_term` увеличивается срок ИИ, а не ось (§3.4, §7.7 п. 6). Такая
	-- опция не входит ни в один эффективный лимит — её видит только продление `ai_until`.
	CONSTRAINT "plan_addons_axis_check" CHECK ("axis" IN (
		'users_active', 'candidates_active', 'storage_bytes', 'ai_generate_ops', 'ai_review_ops',
		'ai_interview_ops', 'sms_out', 'telegram_out', 'integrations_active', 'api_rate_rpm',
		'export_rows', 'ai_term')),
	CONSTRAINT "plan_addons_term_check" CHECK ("term" IN ('period', 'perpetual')),
	-- unit_step — в единице своей оси (§3.4: 100 ГБ, 1000 операций, 90 дней), то есть байты
	-- для storage_bytes, операции для ИИ-осей, дни для ai_term
	CONSTRAINT "plan_addons_unit_step_check" CHECK ("unit_step" > 0)
);--> statement-breakpoint

-- Пять кодов каталога названы в §3.4 дословно. Вставка идемпотентна: значения — параметры
-- оператора платформы, менять их он вправе на экране, а не новой миграцией.
INSERT INTO plan_addons (code, name, axis, unit_step, term, sort) VALUES
	('storage_pack',    'Додаткове сховище, +100 ГБ',   'storage_bytes',    107374182400, 'period', 0),
	('ai_ops_pack',     'Пакет ШІ-операцій, +1000',     'ai_generate_ops',  1000,         'period', 1),
	('sms_pack',        'Пакет SMS, +1000',             'sms_out',          1000,         'period', 2),
	('candidates_pack', 'Додаткові кандидати, +100',    'candidates_active', 100,         'period', 3),
	('ai_term',         'Продовження ШІ, +90 днів',     'ai_term',          90,           'perpetual', 4)
ON CONFLICT (code) DO NOTHING;--> statement-breakpoint

-- ── 4. tenant_addons — докупленные опции тенанта (§3.5). Тенантная таблица, RLS ──────────
CREATE TABLE "tenant_addons" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	"updated_at" timestamp with time zone DEFAULT now() NOT NULL,
	"tenant_id" uuid NOT NULL,
	"addon_code" text NOT NULL,
	"qty" integer NOT NULL,
	-- Снимок шага на момент покупки: пересмотр каталога не переписывает задним числом уже
	-- оплаченное (§3.5, тот же мотив, что у usage_counters.limit_snapshot в §7.3)
	"unit_step" bigint NOT NULL,
	"valid_from" date DEFAULT current_date NOT NULL,
	"valid_until" date,                       -- null = до отключения оператором
	"source" text DEFAULT 'purchase' NOT NULL,
	"payment_id" uuid,                        -- FK на tenant_payments появится в PR-10
	"created_by" uuid,
	CONSTRAINT "tenant_addons_qty_check" CHECK ("qty" > 0),
	CONSTRAINT "tenant_addons_unit_step_check" CHECK ("unit_step" > 0),
	CONSTRAINT "tenant_addons_source_check" CHECK ("source" IN ('purchase', 'grant', 'compensation'))
);--> statement-breakpoint
ALTER TABLE "tenant_addons" ADD CONSTRAINT "tenant_addons_tenant_id_tenants_id_fk" FOREIGN KEY ("tenant_id") REFERENCES "public"."tenants"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "tenant_addons" ADD CONSTRAINT "tenant_addons_addon_code_plan_addons_code_fk" FOREIGN KEY ("addon_code") REFERENCES "public"."plan_addons"("code") ON DELETE restrict ON UPDATE cascade;--> statement-breakpoint
-- Индекс с tenant_id первым и непартиальный (контрактный тест v2-contract-02, docs/25 §15)
CREATE INDEX "tenant_addons_tenant_id_addon_code_valid_until_index" ON "tenant_addons" USING btree ("tenant_id","addon_code","valid_until");--> statement-breakpoint
-- Таблица тенанта — RLS обязателен (CLAUDE.md п. 1, контрактный тест v2-contract-01)
ALTER TABLE tenant_addons ENABLE ROW LEVEL SECURITY;--> statement-breakpoint
ALTER TABLE tenant_addons FORCE ROW LEVEL SECURITY;--> statement-breakpoint
CREATE POLICY tenant_isolation ON tenant_addons
  USING (tenant_id = nullif(current_setting('app.tenant_id', true), '')::uuid)
  WITH CHECK (tenant_id = nullif(current_setting('app.tenant_id', true), '')::uuid);--> statement-breakpoint

-- ── 5. tenant_limits: восемь колонок подписки (§3.2) плюс пять осей лимита (В-5) ─────────
-- Восемь колонок пакета: строка перестаёт быть «только переопределения» и становится
-- состоянием подписки тенанта. Отсюда правило в platformTenants.setTenantLimits: строку со
-- сроками и статусом сбросом переопределений больше не удаляем (docs/28 §v2-08).
ALTER TABLE "tenant_limits" ADD COLUMN "billing_period" text DEFAULT 'month' NOT NULL;--> statement-breakpoint
ALTER TABLE "tenant_limits" ADD COLUMN "status" text DEFAULT 'trial' NOT NULL;--> statement-breakpoint
ALTER TABLE "tenant_limits" ADD COLUMN "paid_until" date;--> statement-breakpoint
ALTER TABLE "tenant_limits" ADD COLUMN "grace_until" date;--> statement-breakpoint
ALTER TABLE "tenant_limits" ADD COLUMN "ai_until" date;--> statement-breakpoint
ALTER TABLE "tenant_limits" ADD COLUMN "autorenew" boolean DEFAULT true NOT NULL;--> statement-breakpoint
ALTER TABLE "tenant_limits" ADD COLUMN "currency" char(3) DEFAULT 'EUR' NOT NULL;--> statement-breakpoint
ALTER TABLE "tenant_limits" ADD COLUMN "ai_status" text DEFAULT 'active' NOT NULL;--> statement-breakpoint
ALTER TABLE "tenant_limits" ADD CONSTRAINT "tenant_limits_billing_period_check" CHECK ("billing_period" IN ('month', 'year'));--> statement-breakpoint
ALTER TABLE "tenant_limits" ADD CONSTRAINT "tenant_limits_status_check" CHECK ("status" IN ('trial', 'active', 'grace', 'readonly', 'suspended'));--> statement-breakpoint
ALTER TABLE "tenant_limits" ADD CONSTRAINT "tenant_limits_ai_status_check" CHECK ("ai_status" IN ('active', 'expired', 'off'));--> statement-breakpoint

-- Оси с шести до одиннадцати (П-25.1 в редакции «шесть осей → одиннадцать»). Существующие
-- шесть колонок не переименовываются: `users` = users_active, `storage_gb` = storage_bytes,
-- `sms_per_month` = sms_out, `api_per_minute` = api_rate_rpm, `webhooks` = integrations_active
-- (смысл расширен на коннекторы), `active_jobs` — ось вне пакета. Новых пять:
ALTER TABLE "tenant_limits" ADD COLUMN "candidates" integer;--> statement-breakpoint
ALTER TABLE "tenant_limits" ADD COLUMN "ai_generate_ops" integer;--> statement-breakpoint
ALTER TABLE "tenant_limits" ADD COLUMN "ai_review_ops" integer;--> statement-breakpoint
ALTER TABLE "tenant_limits" ADD COLUMN "ai_interview_ops" integer;--> statement-breakpoint
ALTER TABLE "tenant_limits" ADD COLUMN "export_rows" integer;--> statement-breakpoint
COMMENT ON COLUMN "tenant_limits"."webhooks" IS 'Ось integrations_active (docs/v2/35 §7.1): вебхуки и коннекторы; колонка не переименовывается (docs/v2/44 В-5)';--> statement-breakpoint
COMMENT ON COLUMN "tenant_limits"."api_per_minute" IS 'Ось api_rate_rpm (docs/v2/35 §7.1); умолчание 60 — DEFAULT_API_PER_MINUTE';--> statement-breakpoint
COMMENT ON COLUMN "tenant_limits"."active_jobs" IS 'Квота задач на круг воркера (docs/25 §5) — ось вне пакета docs/v2/35';
