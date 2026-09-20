-- Spec 24 (docs/24): роли — описание и область по умолчанию; impersonation — оператор и причина в сессии;
-- шкалы range|levels; переводы тенанта; потребление tenant_usage.
ALTER TABLE "roles" ADD COLUMN "description" text;--> statement-breakpoint
ALTER TABLE "roles" ADD COLUMN "default_scope_type" text DEFAULT 'location' NOT NULL;--> statement-breakpoint
ALTER TABLE "roles" ADD CONSTRAINT "roles_default_scope_type_check" CHECK (default_scope_type IN ('tenant', 'org_unit', 'location'));--> statement-breakpoint
UPDATE "roles" SET default_scope_type = 'tenant' WHERE code IN ('admin', 'author');--> statement-breakpoint
ALTER TABLE "sessions" ADD COLUMN "impersonator_admin_id" uuid;--> statement-breakpoint
ALTER TABLE "sessions" ADD COLUMN "impersonation_reason" text;--> statement-breakpoint
ALTER TABLE "sessions" ADD CONSTRAINT "sessions_impersonator_admin_id_platform_admins_id_fk" FOREIGN KEY ("impersonator_admin_id") REFERENCES "public"."platform_admins"("id") ON DELETE set null ON UPDATE no action;--> statement-breakpoint
DROP FUNCTION IF EXISTS auth_session_by_token(text);--> statement-breakpoint
CREATE FUNCTION auth_session_by_token(p_token_hash text)
RETURNS TABLE (
  session_id uuid, tenant_id uuid, user_id uuid,
  expires_at timestamptz, revoked_at timestamptz, impersonated_by uuid, active_role_id uuid,
  impersonator_admin_id uuid
)
LANGUAGE sql SECURITY DEFINER STABLE
SET search_path = public
AS $$
  SELECT s.id, s.tenant_id, s.user_id, s.expires_at, s.revoked_at, s.impersonated_by, s.active_role_id, s.impersonator_admin_id
  FROM sessions s
  WHERE s.token_hash = p_token_hash;
$$;--> statement-breakpoint
REVOKE ALL ON FUNCTION auth_session_by_token(text) FROM public;--> statement-breakpoint
GRANT EXECUTE ON FUNCTION auth_session_by_token(text) TO app_user;--> statement-breakpoint
CREATE TABLE "scales" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	"updated_at" timestamp with time zone DEFAULT now() NOT NULL,
	"tenant_id" uuid NOT NULL,
	"name" text NOT NULL,
	"description" text,
	"kind" text NOT NULL,
	"display_as" text,
	CONSTRAINT "scales_tenant_id_name_unique" UNIQUE("tenant_id","name"),
	CONSTRAINT "scales_kind_check" CHECK (kind IN ('range', 'levels')),
	CONSTRAINT "scales_display_as_check" CHECK (display_as IS NULL OR display_as IN ('label', 'value'))
);--> statement-breakpoint
CREATE TABLE "scale_levels" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	"updated_at" timestamp with time zone DEFAULT now() NOT NULL,
	"tenant_id" uuid NOT NULL,
	"scale_id" uuid NOT NULL,
	"label" text NOT NULL,
	"value" numeric(8, 2),
	"range_from" numeric(5, 2),
	"range_to" numeric(5, 2),
	"characteristic" text,
	"show_in_reports" boolean DEFAULT true NOT NULL,
	"sort_order" integer DEFAULT 0 NOT NULL
);--> statement-breakpoint
ALTER TABLE "scale_levels" ADD CONSTRAINT "scale_levels_scale_id_scales_id_fk" FOREIGN KEY ("scale_id") REFERENCES "public"."scales"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
CREATE INDEX "scale_levels_tenant_id_scale_id_sort_order_index" ON "scale_levels" USING btree ("tenant_id","scale_id","sort_order");--> statement-breakpoint
CREATE INDEX "scales_tenant_id_index" ON "scales" USING btree ("tenant_id");--> statement-breakpoint
CREATE TABLE "translations" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	"updated_at" timestamp with time zone DEFAULT now() NOT NULL,
	"tenant_id" uuid NOT NULL,
	"locale" text NOT NULL,
	"key" text NOT NULL,
	"value" text NOT NULL,
	"updated_by" uuid,
	CONSTRAINT "translations_tenant_id_locale_key_unique" UNIQUE("tenant_id","locale","key")
);--> statement-breakpoint
ALTER TABLE "translations" ADD CONSTRAINT "translations_updated_by_users_id_fk" FOREIGN KEY ("updated_by") REFERENCES "public"."users"("id") ON DELETE set null ON UPDATE no action;--> statement-breakpoint
CREATE TABLE "tenant_usage" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	"updated_at" timestamp with time zone DEFAULT now() NOT NULL,
	"tenant_id" uuid NOT NULL,
	"collected_at" timestamp with time zone DEFAULT now() NOT NULL,
	"active_users" integer DEFAULT 0 NOT NULL,
	"blocked_users" integer DEFAULT 0 NOT NULL,
	"archived_users" integer DEFAULT 0 NOT NULL,
	"storage_bytes" bigint DEFAULT 0 NOT NULL,
	"sms_month" integer DEFAULT 0 NOT NULL,
	"courses_count" integer DEFAULT 0 NOT NULL,
	"assignments_count" integer DEFAULT 0 NOT NULL,
	"attempts_month" integer DEFAULT 0 NOT NULL
);--> statement-breakpoint
CREATE INDEX "tenant_usage_tenant_id_collected_at_index" ON "tenant_usage" USING btree ("tenant_id","collected_at" DESC NULLS LAST);--> statement-breakpoint
ALTER TABLE scales ENABLE ROW LEVEL SECURITY;--> statement-breakpoint
ALTER TABLE scales FORCE ROW LEVEL SECURITY;--> statement-breakpoint
CREATE POLICY tenant_isolation ON scales
  USING (tenant_id = nullif(current_setting('app.tenant_id', true), '')::uuid)
  WITH CHECK (tenant_id = nullif(current_setting('app.tenant_id', true), '')::uuid);--> statement-breakpoint
ALTER TABLE scale_levels ENABLE ROW LEVEL SECURITY;--> statement-breakpoint
ALTER TABLE scale_levels FORCE ROW LEVEL SECURITY;--> statement-breakpoint
CREATE POLICY tenant_isolation ON scale_levels
  USING (tenant_id = nullif(current_setting('app.tenant_id', true), '')::uuid)
  WITH CHECK (tenant_id = nullif(current_setting('app.tenant_id', true), '')::uuid);--> statement-breakpoint
ALTER TABLE translations ENABLE ROW LEVEL SECURITY;--> statement-breakpoint
ALTER TABLE translations FORCE ROW LEVEL SECURITY;--> statement-breakpoint
CREATE POLICY tenant_isolation ON translations
  USING (tenant_id = nullif(current_setting('app.tenant_id', true), '')::uuid)
  WITH CHECK (tenant_id = nullif(current_setting('app.tenant_id', true), '')::uuid);--> statement-breakpoint
ALTER TABLE tenant_usage ENABLE ROW LEVEL SECURITY;--> statement-breakpoint
ALTER TABLE tenant_usage FORCE ROW LEVEL SECURITY;--> statement-breakpoint
CREATE POLICY tenant_isolation ON tenant_usage
  USING (tenant_id = nullif(current_setting('app.tenant_id', true), '')::uuid)
  WITH CHECK (tenant_id = nullif(current_setting('app.tenant_id', true), '')::uuid);--> statement-breakpoint
-- Перенос: акцент, если кто-то писал его в settings, — в branding.accent (docs/02: branding {logo_key, accent, space_name})
UPDATE tenants SET branding = branding || jsonb_build_object('accent', settings->>'accentColor') WHERE settings ? 'accentColor' AND NOT (branding ? 'accent');--> statement-breakpoint
UPDATE tenants SET settings = settings - 'accentColor' WHERE settings ? 'accentColor';
