CREATE TABLE "api_tokens" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	"updated_at" timestamp with time zone DEFAULT now() NOT NULL,
	"tenant_id" uuid NOT NULL,
	"name" text NOT NULL,
	"token_hash" text NOT NULL,
	"prefix" text NOT NULL,
	"scopes" text[] NOT NULL,
	"last_used_at" timestamp with time zone,
	"expires_at" timestamp with time zone,
	"revoked_at" timestamp with time zone,
	"created_by" uuid,
	CONSTRAINT "api_tokens_token_hash_unique" UNIQUE("token_hash")
);
--> statement-breakpoint
CREATE TABLE "plans" (
	"code" text PRIMARY KEY NOT NULL,
	"name" text NOT NULL,
	"max_users" integer,
	"max_storage_gb" integer,
	"max_sms_per_month" integer,
	"features" jsonb DEFAULT '{}'::jsonb NOT NULL,
	"price_uah" integer,
	"sort" integer DEFAULT 0 NOT NULL
);
--> statement-breakpoint
CREATE TABLE "platform_admins" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	"updated_at" timestamp with time zone DEFAULT now() NOT NULL,
	"email" text NOT NULL,
	"full_name" text NOT NULL,
	"password_hash" text NOT NULL,
	"is_active" boolean DEFAULT true NOT NULL,
	"last_login_at" timestamp with time zone,
	CONSTRAINT "platform_admins_email_unique" UNIQUE("email")
);
--> statement-breakpoint
CREATE TABLE "platform_sessions" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	"updated_at" timestamp with time zone DEFAULT now() NOT NULL,
	"admin_id" uuid NOT NULL,
	"token_hash" text NOT NULL,
	"expires_at" timestamp with time zone NOT NULL,
	"revoked_at" timestamp with time zone,
	CONSTRAINT "platform_sessions_token_hash_unique" UNIQUE("token_hash")
);
--> statement-breakpoint
CREATE TABLE "sms_usage" (
	"tenant_id" uuid NOT NULL,
	"month" text NOT NULL,
	"count" integer DEFAULT 0 NOT NULL,
	CONSTRAINT "sms_usage_tenant_id_month_unique" UNIQUE("tenant_id","month")
);
--> statement-breakpoint
CREATE TABLE "tenant_secrets" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	"updated_at" timestamp with time zone DEFAULT now() NOT NULL,
	"tenant_id" uuid NOT NULL,
	"provider" text NOT NULL,
	"key" text NOT NULL,
	"value_encrypted" "bytea" NOT NULL,
	"nonce" "bytea" NOT NULL,
	"account_label" text,
	"status" text DEFAULT 'active' NOT NULL,
	"last_ok_at" timestamp with time zone,
	"last_error" text,
	"created_by" uuid,
	CONSTRAINT "tenant_secrets_tenant_id_provider_key_unique" UNIQUE("tenant_id","provider","key")
);
--> statement-breakpoint
CREATE TABLE "webhook_deliveries" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	"updated_at" timestamp with time zone DEFAULT now() NOT NULL,
	"tenant_id" uuid NOT NULL,
	"endpoint_id" uuid NOT NULL,
	"event" text NOT NULL,
	"payload" jsonb NOT NULL,
	"attempt" integer DEFAULT 0 NOT NULL,
	"status" text DEFAULT 'pending' NOT NULL,
	"status_code" integer,
	"response_body" text,
	"next_attempt_at" timestamp with time zone,
	"delivered_at" timestamp with time zone
);
--> statement-breakpoint
CREATE TABLE "webhook_endpoints" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	"updated_at" timestamp with time zone DEFAULT now() NOT NULL,
	"tenant_id" uuid NOT NULL,
	"url" text NOT NULL,
	"secret_encrypted" "bytea" NOT NULL,
	"nonce" "bytea" NOT NULL,
	"events" text[] NOT NULL,
	"is_active" boolean DEFAULT true NOT NULL,
	"description" text,
	"created_by" uuid
);
--> statement-breakpoint
ALTER TABLE "api_tokens" ADD CONSTRAINT "api_tokens_created_by_users_id_fk" FOREIGN KEY ("created_by") REFERENCES "public"."users"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "platform_sessions" ADD CONSTRAINT "platform_sessions_admin_id_platform_admins_id_fk" FOREIGN KEY ("admin_id") REFERENCES "public"."platform_admins"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "tenant_secrets" ADD CONSTRAINT "tenant_secrets_created_by_users_id_fk" FOREIGN KEY ("created_by") REFERENCES "public"."users"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "webhook_deliveries" ADD CONSTRAINT "webhook_deliveries_endpoint_id_webhook_endpoints_id_fk" FOREIGN KEY ("endpoint_id") REFERENCES "public"."webhook_endpoints"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "webhook_endpoints" ADD CONSTRAINT "webhook_endpoints_created_by_users_id_fk" FOREIGN KEY ("created_by") REFERENCES "public"."users"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
CREATE INDEX "webhook_deliveries_tenant_id_status_next_attempt_at_index" ON "webhook_deliveries" USING btree ("tenant_id","status","next_attempt_at");--> statement-breakpoint
-- RLS для таблиц с tenant_id (правило CLAUDE.md №4); platform_* и plans — платформенные, без RLS
DO $$
DECLARE t text;
BEGIN
  FOREACH t IN ARRAY ARRAY['tenant_secrets', 'webhook_endpoints', 'webhook_deliveries', 'api_tokens', 'sms_usage']
  LOOP
    EXECUTE format('ALTER TABLE %I ENABLE ROW LEVEL SECURITY', t);
    EXECUTE format('ALTER TABLE %I FORCE ROW LEVEL SECURITY', t);
    EXECUTE format($p$
      CREATE POLICY tenant_isolation ON %I
        USING (tenant_id = nullif(current_setting('app.tenant_id', true), '')::uuid)
        WITH CHECK (tenant_id = nullif(current_setting('app.tenant_id', true), '')::uuid)
    $p$, t);
  END LOOP;
END $$;
--> statement-breakpoint
-- Bearer-токен ищется до контекста тенанта (docs/04 §4.1)
CREATE OR REPLACE FUNCTION auth_api_token(p_token_hash text)
RETURNS TABLE (token_id uuid, tenant_id uuid, scopes text[], expires_at timestamptz, revoked_at timestamptz, created_by uuid)
LANGUAGE sql SECURITY DEFINER STABLE SET search_path = public
AS $$ SELECT id, tenant_id, scopes, expires_at, revoked_at, created_by FROM api_tokens WHERE token_hash = p_token_hash; $$;
--> statement-breakpoint
REVOKE ALL ON FUNCTION auth_api_token(text) FROM public;--> statement-breakpoint
GRANT EXECUTE ON FUNCTION auth_api_token(text) TO app_user;--> statement-breakpoint
-- Роль platform_admin (docs/02 §2.12): BYPASSRLS, только для модуля панели оператора
DO $$
BEGIN
  IF NOT EXISTS (SELECT 1 FROM pg_roles WHERE rolname = 'platform_admin') THEN
    CREATE ROLE platform_admin LOGIN PASSWORD 'platform_admin_dev' BYPASSRLS;
  END IF;
END $$;
--> statement-breakpoint
GRANT USAGE ON SCHEMA public TO platform_admin;--> statement-breakpoint
GRANT SELECT, INSERT, UPDATE, DELETE ON ALL TABLES IN SCHEMA public TO platform_admin;--> statement-breakpoint
GRANT USAGE, SELECT ON ALL SEQUENCES IN SCHEMA public TO platform_admin;--> statement-breakpoint
ALTER DEFAULT PRIVILEGES IN SCHEMA public GRANT SELECT, INSERT, UPDATE, DELETE ON TABLES TO platform_admin;--> statement-breakpoint
ALTER DEFAULT PRIVILEGES IN SCHEMA public GRANT USAGE, SELECT ON SEQUENCES TO platform_admin;--> statement-breakpoint
-- Тарифы по умолчанию (docs/02 §2.1)
INSERT INTO plans (code, name, max_users, max_storage_gb, max_sms_per_month, features, price_uah, sort) VALUES
  ('trial',   'Пробний',  30,   2,   50,  '{"knowledge":true,"workshops":true,"surveys":true,"api":false,"webhooks":false}', 0,    0),
  ('point',   'Точка',    100,  20,  500, '{"knowledge":true,"workshops":true,"surveys":true,"api":true,"webhooks":true}',   1500, 1),
  ('network', 'Мережа',   1000, 200, 5000,'{"knowledge":true,"workshops":true,"surveys":true,"api":true,"webhooks":true}',   6000, 2),
  ('custom',  'Індивідуальний', NULL, NULL, NULL, '{"knowledge":true,"workshops":true,"surveys":true,"api":true,"webhooks":true}', NULL, 3)
ON CONFLICT (code) DO NOTHING;
