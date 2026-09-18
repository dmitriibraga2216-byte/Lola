CREATE TABLE "assignments" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	"updated_at" timestamp with time zone DEFAULT now() NOT NULL,
	"tenant_id" uuid NOT NULL,
	"title" text NOT NULL,
	"kind" text DEFAULT 'manual' NOT NULL,
	"subject_type" text DEFAULT 'course' NOT NULL,
	"subject_id" uuid NOT NULL,
	"subject_version_id" uuid,
	"audience" jsonb NOT NULL,
	"exclude" jsonb DEFAULT '{"rules":[]}'::jsonb NOT NULL,
	"starts_at" timestamp with time zone,
	"due_mode" text DEFAULT 'relative' NOT NULL,
	"due_at" timestamp with time zone,
	"due_days" integer DEFAULT 14,
	"is_mandatory" boolean DEFAULT true NOT NULL,
	"recurrence" jsonb,
	"params" jsonb DEFAULT '{}'::jsonb NOT NULL,
	"reminders" jsonb DEFAULT '{}'::jsonb NOT NULL,
	"auto_sync" boolean DEFAULT true NOT NULL,
	"tags" text[] DEFAULT '{}'::text[] NOT NULL,
	"status" text DEFAULT 'active' NOT NULL,
	"created_by" uuid,
	"profile_id" uuid,
	"stats" jsonb DEFAULT '{}'::jsonb NOT NULL,
	"last_sync_at" timestamp with time zone
);
--> statement-breakpoint
CREATE TABLE "automation_rules" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	"updated_at" timestamp with time zone DEFAULT now() NOT NULL,
	"tenant_id" uuid NOT NULL,
	"name" text NOT NULL,
	"trigger" text NOT NULL,
	"conditions" jsonb DEFAULT '{}'::jsonb NOT NULL,
	"actions" jsonb NOT NULL,
	"is_active" boolean DEFAULT true NOT NULL,
	"run_limit" jsonb DEFAULT '{"oncePerUser":true}'::jsonb NOT NULL,
	"last_run_at" timestamp with time zone,
	"stats" jsonb DEFAULT '{}'::jsonb NOT NULL
);
--> statement-breakpoint
CREATE TABLE "automation_runs" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	"updated_at" timestamp with time zone DEFAULT now() NOT NULL,
	"tenant_id" uuid NOT NULL,
	"rule_id" uuid NOT NULL,
	"user_id" uuid,
	"trigger_payload" jsonb DEFAULT '{}'::jsonb NOT NULL,
	"actions_result" jsonb DEFAULT '[]'::jsonb NOT NULL,
	"status" text DEFAULT 'ok' NOT NULL,
	"error" text,
	CONSTRAINT "automation_runs_tenant_id_rule_id_user_id_unique" UNIQUE("tenant_id","rule_id","user_id")
);
--> statement-breakpoint
CREATE TABLE "learning_profiles" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	"updated_at" timestamp with time zone DEFAULT now() NOT NULL,
	"tenant_id" uuid NOT NULL,
	"name" text NOT NULL,
	"scope" jsonb NOT NULL,
	"items" jsonb NOT NULL,
	"applies_to_existing" boolean DEFAULT false NOT NULL,
	"is_active" boolean DEFAULT true NOT NULL,
	"last_applied_at" timestamp with time zone
);
--> statement-breakpoint
CREATE TABLE "notification_templates" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	"updated_at" timestamp with time zone DEFAULT now() NOT NULL,
	"tenant_id" uuid NOT NULL,
	"code" text NOT NULL,
	"channel" text NOT NULL,
	"locale" text DEFAULT 'uk' NOT NULL,
	"subject" text,
	"body" text NOT NULL,
	"is_enabled" boolean DEFAULT true NOT NULL,
	CONSTRAINT "notification_templates_tenant_id_code_channel_locale_unique" UNIQUE("tenant_id","code","channel","locale")
);
--> statement-breakpoint
CREATE TABLE "notifications" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	"updated_at" timestamp with time zone DEFAULT now() NOT NULL,
	"tenant_id" uuid NOT NULL,
	"user_id" uuid NOT NULL,
	"code" text NOT NULL,
	"channel" text NOT NULL,
	"payload" jsonb DEFAULT '{}'::jsonb NOT NULL,
	"rendered_text" text,
	"dedup_key" text,
	"status" text DEFAULT 'queued' NOT NULL,
	"error" text,
	"scheduled_for" timestamp with time zone DEFAULT now() NOT NULL,
	"sent_at" timestamp with time zone,
	CONSTRAINT "notifications_tenant_id_dedup_key_unique" UNIQUE("tenant_id","dedup_key")
);
--> statement-breakpoint
CREATE TABLE "telegram_tokens" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	"updated_at" timestamp with time zone DEFAULT now() NOT NULL,
	"tenant_id" uuid NOT NULL,
	"user_id" uuid NOT NULL,
	"kind" text NOT NULL,
	"token_hash" text NOT NULL,
	"expires_at" timestamp with time zone NOT NULL,
	"consumed_at" timestamp with time zone,
	CONSTRAINT "telegram_tokens_token_hash_unique" UNIQUE("token_hash")
);
--> statement-breakpoint
ALTER TABLE "assignments" ADD CONSTRAINT "assignments_created_by_users_id_fk" FOREIGN KEY ("created_by") REFERENCES "public"."users"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "automation_runs" ADD CONSTRAINT "automation_runs_rule_id_automation_rules_id_fk" FOREIGN KEY ("rule_id") REFERENCES "public"."automation_rules"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "automation_runs" ADD CONSTRAINT "automation_runs_user_id_users_id_fk" FOREIGN KEY ("user_id") REFERENCES "public"."users"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "notifications" ADD CONSTRAINT "notifications_user_id_users_id_fk" FOREIGN KEY ("user_id") REFERENCES "public"."users"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "telegram_tokens" ADD CONSTRAINT "telegram_tokens_user_id_users_id_fk" FOREIGN KEY ("user_id") REFERENCES "public"."users"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
CREATE INDEX "assignments_tenant_id_status_index" ON "assignments" USING btree ("tenant_id","status");--> statement-breakpoint
CREATE INDEX "assignments_tenant_id_subject_id_index" ON "assignments" USING btree ("tenant_id","subject_id");--> statement-breakpoint
CREATE INDEX "automation_runs_tenant_id_rule_id_created_at_index" ON "automation_runs" USING btree ("tenant_id","rule_id","created_at" DESC NULLS LAST);--> statement-breakpoint
CREATE INDEX "notifications_tenant_id_status_scheduled_for_index" ON "notifications" USING btree ("tenant_id","status","scheduled_for");--> statement-breakpoint
CREATE INDEX "notifications_tenant_id_user_id_created_at_index" ON "notifications" USING btree ("tenant_id","user_id","created_at" DESC NULLS LAST);--> statement-breakpoint
-- RLS для новых таблиц (правило CLAUDE.md №4)
DO $$
DECLARE t text;
BEGIN
  FOREACH t IN ARRAY ARRAY[
    'assignments', 'learning_profiles', 'automation_rules', 'automation_runs',
    'notification_templates', 'notifications', 'telegram_tokens'
  ]
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
-- Telegram-бот работает до контекста тенанта: токен → (tenant, user) через SECURITY DEFINER
CREATE OR REPLACE FUNCTION telegram_token_lookup(p_token_hash text)
RETURNS TABLE (token_id uuid, tenant_id uuid, user_id uuid, kind text, expires_at timestamptz, consumed_at timestamptz)
LANGUAGE sql SECURITY DEFINER STABLE SET search_path = public
AS $$ SELECT id, tenant_id, user_id, kind, expires_at, consumed_at FROM telegram_tokens WHERE token_hash = p_token_hash; $$;
--> statement-breakpoint
CREATE OR REPLACE FUNCTION telegram_chat_lookup(p_chat_id bigint)
RETURNS TABLE (tenant_id uuid, user_id uuid, full_name text)
LANGUAGE sql SECURITY DEFINER STABLE SET search_path = public
AS $$ SELECT tenant_id, id, full_name FROM users WHERE telegram_chat_id = p_chat_id AND status = 'active'; $$;
--> statement-breakpoint
REVOKE ALL ON FUNCTION telegram_token_lookup(text) FROM public;--> statement-breakpoint
REVOKE ALL ON FUNCTION telegram_chat_lookup(bigint) FROM public;--> statement-breakpoint
GRANT EXECUTE ON FUNCTION telegram_token_lookup(text) TO app_user;--> statement-breakpoint
GRANT EXECUTE ON FUNCTION telegram_chat_lookup(bigint) TO app_user;
