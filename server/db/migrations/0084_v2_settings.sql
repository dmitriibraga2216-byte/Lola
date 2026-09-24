-- docs/v2/45-plan.md PR-39 · Настройки тенанта и платформы · патчи docs/v2/39 П-21, П-24.1,
-- П-24.2, П-24.3, П-24.5 · решение docs/v2/44 В-20 (флаг sessionOnly — без миграции: он живёт в
-- реестре скоупов `shared/domain/roles.ts`, а не в БД).
--
-- ── Что здесь ───────────────────────────────────────────────────────────────────────────
-- 1. `platform_announcements` — объявления платформы, вторая «новость» (П-21, П-24.2).
--    Платформенная таблица без tenant_id и вне RLS, по образцу plans/plan_prices/plan_addons
--    (docs/v2/40 §6.2). Писать может только platform_admin: у app_user отозваны insert/update/
--    delete — сессия тенанта не создаст объявление платформы даже ошибкой кода.
-- 2. `platform_announcement_reads` — отметка «прочитано» (тенантная, под RLS).
-- 3. `position_groups` + `positions.group_id` (П-24.5).
-- 4. `automation_rules.position_id` / `position_group_id` — «посада → курси за замовчуванням»
--    правилом автоматизации (П-24.3); отдельной таблицы нет.
-- 5. `user_totp` + `user_totp_recovery_codes` + `sessions.two_factor_pending` — второй фактор
--    входа (П-24.1, docs/24 §3.4); `auth_session_by_token` отдаёт признак промежуточной сессии.
-- 6. `absence_norms` — нормы отпуска и больничного, компания и точка (П-24.1, docs/v2/38 §3.6).
--    DDL — из `38` §3.6; сверх него `updated_at` (общие поля таблицы, docs/02) и `set_by`
--    nullable с `on delete set null` (как у прочих «кто правил»: человек не удаляется, но
--    стирание по GDPR не должно упираться в справочную норму).

-- ── 1. Объявления платформы ─────────────────────────────────────────────────────────────
CREATE TABLE "platform_announcements" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	"updated_at" timestamp with time zone DEFAULT now() NOT NULL,
	"title" text NOT NULL,
	"body" text NOT NULL,
	"audience" text DEFAULT 'all' NOT NULL,
	"plan_codes" text[] DEFAULT '{}'::text[] NOT NULL,
	"tenant_ids" uuid[] DEFAULT '{}'::uuid[] NOT NULL,
	"published_at" timestamp with time zone,
	"archived_at" timestamp with time zone,
	"created_by" uuid,
	CONSTRAINT "platform_announcements_audience_chk" CHECK ("audience" IN ('all', 'plans', 'tenants')),
	-- Адресация согласована с видом: «всем» — без списков, «по тарифу» — только тарифы,
	-- «конкретным тенантам» — только тенанты. Пустой список при адресной рассылке — ошибка, а
	-- не «никому»: объявление, которого никто не увидит, оператор должен заметить сразу.
	CONSTRAINT "platform_announcements_target_chk" CHECK (
		("audience" = 'all' AND cardinality("plan_codes") = 0 AND cardinality("tenant_ids") = 0)
		OR ("audience" = 'plans' AND cardinality("plan_codes") > 0 AND cardinality("tenant_ids") = 0)
		OR ("audience" = 'tenants' AND cardinality("tenant_ids") > 0 AND cardinality("plan_codes") = 0)
	),
	CONSTRAINT "platform_announcements_title_chk" CHECK (char_length("title") BETWEEN 3 AND 200),
	CONSTRAINT "platform_announcements_body_chk" CHECK (char_length("body") BETWEEN 1 AND 5000),
	CONSTRAINT "platform_announcements_archived_chk" CHECK ("archived_at" IS NULL OR "published_at" IS NOT NULL)
);
--> statement-breakpoint
ALTER TABLE "platform_announcements" ADD CONSTRAINT "platform_announcements_created_by_platform_admins_id_fk" FOREIGN KEY ("created_by") REFERENCES "public"."platform_admins"("id") ON DELETE set null ON UPDATE no action;--> statement-breakpoint
CREATE INDEX "idx_platform_announcements_feed" ON "platform_announcements" USING btree ("published_at" DESC) WHERE archived_at IS NULL;--> statement-breakpoint
-- Только чтение для роли приложения (П-21: «все тенанты, только чтение»). Права по умолчанию
-- (0001) выдали app_user полный DML на каждую новую таблицу — здесь он сужается до select.
REVOKE INSERT, UPDATE, DELETE, TRUNCATE ON "platform_announcements" FROM app_user;--> statement-breakpoint
COMMENT ON TABLE "platform_announcements" IS 'Объявления платформы (docs/v2/39 П-21, П-24.2): пишет оператор платформы, тенанты только читают; не корпоративная лента тенанта (news). Без tenant_id, вне RLS; app_user — только select.';--> statement-breakpoint

-- ── 2. Отметка «прочитано» ──────────────────────────────────────────────────────────────
CREATE TABLE "platform_announcement_reads" (
	"tenant_id" uuid NOT NULL,
	"announcement_id" uuid NOT NULL,
	"user_id" uuid NOT NULL,
	"read_at" timestamp with time zone DEFAULT now() NOT NULL,
	CONSTRAINT "platform_announcement_reads_pk" PRIMARY KEY ("tenant_id", "user_id", "announcement_id")
);
--> statement-breakpoint
ALTER TABLE "platform_announcement_reads" ADD CONSTRAINT "platform_announcement_reads_tenant_id_tenants_id_fk" FOREIGN KEY ("tenant_id") REFERENCES "public"."tenants"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "platform_announcement_reads" ADD CONSTRAINT "platform_announcement_reads_announcement_id_fk" FOREIGN KEY ("announcement_id") REFERENCES "public"."platform_announcements"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "platform_announcement_reads" ADD CONSTRAINT "platform_announcement_reads_user_id_users_id_fk" FOREIGN KEY ("user_id") REFERENCES "public"."users"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE platform_announcement_reads ENABLE ROW LEVEL SECURITY;--> statement-breakpoint
ALTER TABLE platform_announcement_reads FORCE ROW LEVEL SECURITY;--> statement-breakpoint
CREATE POLICY tenant_isolation ON platform_announcement_reads
  USING (tenant_id = nullif(current_setting('app.tenant_id', true), '')::uuid)
  WITH CHECK (tenant_id = nullif(current_setting('app.tenant_id', true), '')::uuid);--> statement-breakpoint

-- ── 3. Группы должностей ────────────────────────────────────────────────────────────────
CREATE TABLE "position_groups" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	"updated_at" timestamp with time zone DEFAULT now() NOT NULL,
	"tenant_id" uuid NOT NULL,
	"name" text NOT NULL,
	"sort_order" integer DEFAULT 0 NOT NULL,
	CONSTRAINT "position_groups_name_chk" CHECK (char_length(btrim("name")) BETWEEN 1 AND 120),
	CONSTRAINT "uq_position_groups_name" UNIQUE ("tenant_id", "name")
);
--> statement-breakpoint
ALTER TABLE "position_groups" ADD CONSTRAINT "position_groups_tenant_id_tenants_id_fk" FOREIGN KEY ("tenant_id") REFERENCES "public"."tenants"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
CREATE INDEX "idx_position_groups_tenant" ON "position_groups" USING btree ("tenant_id", "sort_order");--> statement-breakpoint
ALTER TABLE position_groups ENABLE ROW LEVEL SECURITY;--> statement-breakpoint
ALTER TABLE position_groups FORCE ROW LEVEL SECURITY;--> statement-breakpoint
CREATE POLICY tenant_isolation ON position_groups
  USING (tenant_id = nullif(current_setting('app.tenant_id', true), '')::uuid)
  WITH CHECK (tenant_id = nullif(current_setting('app.tenant_id', true), '')::uuid);--> statement-breakpoint
ALTER TABLE "positions" ADD COLUMN "group_id" uuid;--> statement-breakpoint
ALTER TABLE "positions" ADD CONSTRAINT "positions_group_id_position_groups_id_fk" FOREIGN KEY ("group_id") REFERENCES "public"."position_groups"("id") ON DELETE set null ON UPDATE no action;--> statement-breakpoint
CREATE INDEX "idx_positions_group" ON "positions" USING btree ("tenant_id", "group_id") WHERE group_id IS NOT NULL;--> statement-breakpoint

-- ── 4. «Посада → курси за замовчуванням» — правило автоматизации (П-24.3) ───────────────
ALTER TABLE "automation_rules" ADD COLUMN "position_id" uuid;--> statement-breakpoint
ALTER TABLE "automation_rules" ADD COLUMN "position_group_id" uuid;--> statement-breakpoint
ALTER TABLE "automation_rules" ADD CONSTRAINT "automation_rules_position_id_positions_id_fk" FOREIGN KEY ("position_id") REFERENCES "public"."positions"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "automation_rules" ADD CONSTRAINT "automation_rules_position_group_id_position_groups_id_fk" FOREIGN KEY ("position_group_id") REFERENCES "public"."position_groups"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "automation_rules" ADD CONSTRAINT "automation_rules_position_binding_chk" CHECK (num_nonnulls("position_id", "position_group_id") <= 1);--> statement-breakpoint
CREATE UNIQUE INDEX "uq_automation_rules_position" ON "automation_rules" USING btree ("tenant_id", "position_id") WHERE position_id IS NOT NULL;--> statement-breakpoint
CREATE UNIQUE INDEX "uq_automation_rules_position_group" ON "automation_rules" USING btree ("tenant_id", "position_group_id") WHERE position_group_id IS NOT NULL;--> statement-breakpoint

-- ── 5. Второй фактор входа (TOTP) ───────────────────────────────────────────────────────
CREATE TABLE "user_totp" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	"updated_at" timestamp with time zone DEFAULT now() NOT NULL,
	"tenant_id" uuid NOT NULL,
	"user_id" uuid NOT NULL,
	"secret_encrypted" bytea,
	"secret_nonce" bytea,
	"confirmed_at" timestamp with time zone,
	"pending_secret_encrypted" bytea,
	"pending_nonce" bytea,
	"pending_created_at" timestamp with time zone,
	"last_used_step" bigint,
	-- Действующий фактор — это ровно тройка «шифротекст + nonce + дата подтверждения»
	CONSTRAINT "user_totp_active_chk" CHECK (
		("secret_encrypted" IS NULL) = ("secret_nonce" IS NULL) AND ("secret_encrypted" IS NULL) = ("confirmed_at" IS NULL)
	),
	CONSTRAINT "user_totp_pending_chk" CHECK (
		("pending_secret_encrypted" IS NULL) = ("pending_nonce" IS NULL) AND ("pending_secret_encrypted" IS NULL) = ("pending_created_at" IS NULL)
	),
	CONSTRAINT "uq_user_totp_user" UNIQUE ("tenant_id", "user_id")
);
--> statement-breakpoint
ALTER TABLE "user_totp" ADD CONSTRAINT "user_totp_tenant_id_tenants_id_fk" FOREIGN KEY ("tenant_id") REFERENCES "public"."tenants"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "user_totp" ADD CONSTRAINT "user_totp_user_id_users_id_fk" FOREIGN KEY ("user_id") REFERENCES "public"."users"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE user_totp ENABLE ROW LEVEL SECURITY;--> statement-breakpoint
ALTER TABLE user_totp FORCE ROW LEVEL SECURITY;--> statement-breakpoint
CREATE POLICY tenant_isolation ON user_totp
  USING (tenant_id = nullif(current_setting('app.tenant_id', true), '')::uuid)
  WITH CHECK (tenant_id = nullif(current_setting('app.tenant_id', true), '')::uuid);--> statement-breakpoint
COMMENT ON TABLE "user_totp" IS 'Второй фактор входа TOTP (docs/24 §3.4, docs/v2/39 П-24.1): секрет только шифротекстом AES-256-GCM (server/services/crypto.ts), как токены интеграций.';--> statement-breakpoint

CREATE TABLE "user_totp_recovery_codes" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	"updated_at" timestamp with time zone DEFAULT now() NOT NULL,
	"tenant_id" uuid NOT NULL,
	"user_id" uuid NOT NULL,
	"code_hash" text NOT NULL,
	"used_at" timestamp with time zone
);
--> statement-breakpoint
ALTER TABLE "user_totp_recovery_codes" ADD CONSTRAINT "user_totp_recovery_codes_tenant_id_tenants_id_fk" FOREIGN KEY ("tenant_id") REFERENCES "public"."tenants"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "user_totp_recovery_codes" ADD CONSTRAINT "user_totp_recovery_codes_user_id_users_id_fk" FOREIGN KEY ("user_id") REFERENCES "public"."users"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
CREATE INDEX "idx_user_totp_recovery_codes_tenant" ON "user_totp_recovery_codes" USING btree ("tenant_id", "user_id");--> statement-breakpoint
ALTER TABLE user_totp_recovery_codes ENABLE ROW LEVEL SECURITY;--> statement-breakpoint
ALTER TABLE user_totp_recovery_codes FORCE ROW LEVEL SECURITY;--> statement-breakpoint
CREATE POLICY tenant_isolation ON user_totp_recovery_codes
  USING (tenant_id = nullif(current_setting('app.tenant_id', true), '')::uuid)
  WITH CHECK (tenant_id = nullif(current_setting('app.tenant_id', true), '')::uuid);--> statement-breakpoint
COMMENT ON TABLE "user_totp_recovery_codes" IS 'Резервные коды второго фактора: только argon2id-хеши, сам код показывается человеку один раз (docs/24 §3.4, PR-39).';--> statement-breakpoint

ALTER TABLE "sessions" ADD COLUMN "two_factor_pending" boolean DEFAULT false NOT NULL;--> statement-breakpoint
-- auth_session_by_token (0049) отдаёт ещё и признак промежуточной сессии — AuthContext.twoFactorPending
DROP FUNCTION IF EXISTS auth_session_by_token(text);--> statement-breakpoint
CREATE FUNCTION auth_session_by_token(p_token_hash text)
RETURNS TABLE (
  session_id uuid, tenant_id uuid, user_id uuid,
  expires_at timestamptz, revoked_at timestamptz, impersonated_by uuid, active_role_id uuid,
  impersonator_admin_id uuid, preview_role_id uuid, two_factor_pending boolean
)
LANGUAGE sql SECURITY DEFINER STABLE
SET search_path = public
AS $$
  SELECT s.id, s.tenant_id, s.user_id, s.expires_at, s.revoked_at, s.impersonated_by, s.active_role_id, s.impersonator_admin_id, s.preview_role_id, s.two_factor_pending
  FROM sessions s
  WHERE s.token_hash = p_token_hash;
$$;--> statement-breakpoint
REVOKE ALL ON FUNCTION auth_session_by_token(text) FROM public;--> statement-breakpoint
GRANT EXECUTE ON FUNCTION auth_session_by_token(text) TO app_user;--> statement-breakpoint

-- ── 6. Нормы отсутствий (`38` §3.6) ─────────────────────────────────────────────────────
CREATE TABLE "absence_norms" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	"updated_at" timestamp with time zone DEFAULT now() NOT NULL,
	"tenant_id" uuid NOT NULL,
	"scope_type" text NOT NULL,
	"scope_id" uuid,
	"year" integer NOT NULL,
	"vacation_days" numeric(4, 1),
	"sick_days" numeric(4, 1),
	"reason" text,
	"set_by" uuid,
	CONSTRAINT "absence_norms_scope_chk" CHECK ("scope_type" IN ('tenant', 'location', 'user')),
	CONSTRAINT "absence_norms_scope_id_chk" CHECK (("scope_type" = 'tenant') = ("scope_id" IS NULL)),
	CONSTRAINT "absence_norms_year_chk" CHECK ("year" BETWEEN 2020 AND 2100),
	CONSTRAINT "absence_norms_days_chk" CHECK (("vacation_days" IS NULL OR "vacation_days" BETWEEN 0 AND 365)
		AND ("sick_days" IS NULL OR "sick_days" BETWEEN 0 AND 365)),
	CONSTRAINT "absence_norms_reason_chk" CHECK ("scope_type" <> 'user' OR char_length(coalesce("reason", '')) >= 5),
	CONSTRAINT "uq_absence_norms_scope_year" UNIQUE NULLS NOT DISTINCT ("tenant_id", "scope_type", "scope_id", "year")
);
--> statement-breakpoint
ALTER TABLE "absence_norms" ADD CONSTRAINT "absence_norms_tenant_id_tenants_id_fk" FOREIGN KEY ("tenant_id") REFERENCES "public"."tenants"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "absence_norms" ADD CONSTRAINT "absence_norms_set_by_users_id_fk" FOREIGN KEY ("set_by") REFERENCES "public"."users"("id") ON DELETE set null ON UPDATE no action;--> statement-breakpoint
CREATE INDEX "idx_absence_norms_tenant" ON "absence_norms" USING btree ("tenant_id", "year", "scope_type");--> statement-breakpoint
ALTER TABLE absence_norms ENABLE ROW LEVEL SECURITY;--> statement-breakpoint
ALTER TABLE absence_norms FORCE ROW LEVEL SECURITY;--> statement-breakpoint
CREATE POLICY tenant_isolation ON absence_norms
  USING (tenant_id = nullif(current_setting('app.tenant_id', true), '')::uuid)
  WITH CHECK (tenant_id = nullif(current_setting('app.tenant_id', true), '')::uuid);--> statement-breakpoint
COMMENT ON TABLE "absence_norms" IS 'Нормы отпуска и больничного по уровням компания/точка/человек на календарный год (docs/v2/38 §3.6, §7.13): справочная величина, не кадровый учёт; null — наследовать с уровня выше.';
