CREATE TABLE "platform_audit" (
	"id" bigserial PRIMARY KEY NOT NULL,
	"admin_id" uuid,
	"admin_email" text NOT NULL,
	"action" text NOT NULL,
	"subject_tenant_id" uuid,
	"entity" text NOT NULL,
	"entity_id" text,
	"before" jsonb,
	"after" jsonb,
	"request_context" jsonb,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL
);
--> statement-breakpoint
CREATE TABLE "tenant_limits" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	"updated_at" timestamp with time zone DEFAULT now() NOT NULL,
	"tenant_id" uuid NOT NULL,
	"users" integer,
	"storage_gb" integer,
	"sms_per_month" integer,
	"api_per_minute" integer,
	"webhooks" integer,
	"active_jobs" integer,
	"updated_by" uuid,
	CONSTRAINT "tenant_limits_tenant_id_unique" UNIQUE("tenant_id")
);
--> statement-breakpoint
ALTER TABLE "tenants" ADD COLUMN "archived_at" timestamp with time zone;--> statement-breakpoint
ALTER TABLE "platform_audit" ADD CONSTRAINT "platform_audit_admin_id_platform_admins_id_fk" FOREIGN KEY ("admin_id") REFERENCES "public"."platform_admins"("id") ON DELETE set null ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "platform_audit" ADD CONSTRAINT "platform_audit_subject_tenant_id_tenants_id_fk" FOREIGN KEY ("subject_tenant_id") REFERENCES "public"."tenants"("id") ON DELETE set null ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "tenant_limits" ADD CONSTRAINT "tenant_limits_updated_by_platform_admins_id_fk" FOREIGN KEY ("updated_by") REFERENCES "public"."platform_admins"("id") ON DELETE set null ON UPDATE no action;--> statement-breakpoint
CREATE INDEX "platform_audit_subject_tenant_id_created_at_index" ON "platform_audit" USING btree ("subject_tenant_id","created_at" DESC NULLS LAST);--> statement-breakpoint
CREATE INDEX "platform_audit_created_at_index" ON "platform_audit" USING btree ("created_at" DESC NULLS LAST);--> statement-breakpoint
CREATE INDEX "tenant_limits_tenant_id_index" ON "tenant_limits" USING btree ("tenant_id");--> statement-breakpoint
CREATE INDEX "tenants_status_index" ON "tenants" USING btree ("status");--> statement-breakpoint
ALTER TABLE "tenants" ADD CONSTRAINT "tenants_status_check" CHECK ("tenants"."status" in ('active', 'suspended', 'archived'));--> statement-breakpoint
-- Spec 25 (docs/25 §3.2, §7, §8, §10; docs/32 §Б строка 17): tenant_limits изолируется как любая таблица с tenant_id;
-- platform_audit и tenants — платформенные, без RLS (docs/25 §3.1).
ALTER TABLE tenant_limits ENABLE ROW LEVEL SECURITY;--> statement-breakpoint
ALTER TABLE tenant_limits FORCE ROW LEVEL SECURITY;--> statement-breakpoint
CREATE POLICY tenant_isolation ON tenant_limits
  USING (tenant_id = current_setting('app.tenant_id', true)::uuid)
  WITH CHECK (tenant_id = current_setting('app.tenant_id', true)::uuid);
--> statement-breakpoint
-- docs/25 §8, §14 п. 10: приостановленный тенант должен отвечать на вход понятным 403, а не «Код невірний» —
-- функция отдаёт tenant_status, фильтр по статусу тенанта переезжает в приложение (authLookup.usersByPhone)
DROP FUNCTION IF EXISTS auth_users_by_phone(text);--> statement-breakpoint
CREATE FUNCTION auth_users_by_phone(p_phone text)
RETURNS TABLE (
  user_id uuid, tenant_id uuid, tenant_slug text, tenant_name text,
  full_name text, status text, locale text, has_telegram boolean, tenant_status text
)
LANGUAGE sql SECURITY DEFINER STABLE
SET search_path = public
AS $$
  SELECT u.id, u.tenant_id, t.slug, t.name, u.full_name, u.status,
         coalesce(u.locale, t.locale), u.telegram_chat_id IS NOT NULL, t.status
  FROM users u
  JOIN tenants t ON t.id = u.tenant_id
  WHERE u.phone = p_phone
    AND u.status IN ('invited', 'active');
$$;--> statement-breakpoint
REVOKE ALL ON FUNCTION auth_users_by_phone(text) FROM public;--> statement-breakpoint
GRANT EXECUTE ON FUNCTION auth_users_by_phone(text) TO app_user;
