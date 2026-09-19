CREATE TABLE "notification_template_versions" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	"updated_at" timestamp with time zone DEFAULT now() NOT NULL,
	"tenant_id" uuid NOT NULL,
	"template_id" uuid NOT NULL,
	"version" integer NOT NULL,
	"subject" text,
	"body" text NOT NULL,
	"author_id" uuid
);
--> statement-breakpoint
CREATE TABLE "user_notification_prefs" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	"updated_at" timestamp with time zone DEFAULT now() NOT NULL,
	"tenant_id" uuid NOT NULL,
	"user_id" uuid NOT NULL,
	"code" text NOT NULL,
	"enabled" boolean DEFAULT true NOT NULL,
	"channel" text,
	CONSTRAINT "user_notification_prefs_tenant_id_user_id_code_unique" UNIQUE("tenant_id","user_id","code")
);
--> statement-breakpoint
ALTER TABLE "users" ADD COLUMN "telegram_blocked" boolean DEFAULT false NOT NULL;--> statement-breakpoint
ALTER TABLE "notification_templates" ADD COLUMN "buttons" jsonb DEFAULT '[]' NOT NULL;--> statement-breakpoint
ALTER TABLE "notification_templates" ADD COLUMN "is_mandatory" boolean DEFAULT false NOT NULL;--> statement-breakpoint
ALTER TABLE "notification_templates" ADD COLUMN "throttle" jsonb;--> statement-breakpoint
ALTER TABLE "notification_templates" ADD COLUMN "escalate_after_hours" integer;--> statement-breakpoint
ALTER TABLE "notification_templates" ADD COLUMN "ignore_quiet_hours" boolean DEFAULT false NOT NULL;--> statement-breakpoint
ALTER TABLE "notification_templates" ADD COLUMN "version" integer DEFAULT 1 NOT NULL;--> statement-breakpoint
ALTER TABLE "notifications" ADD COLUMN "skip_reason" text;--> statement-breakpoint
ALTER TABLE "notifications" ADD COLUMN "attempt" integer DEFAULT 0 NOT NULL;--> statement-breakpoint
ALTER TABLE "notifications" ADD COLUMN "read_at" timestamp with time zone;--> statement-breakpoint
ALTER TABLE "notifications" ADD COLUMN "reacted_at" timestamp with time zone;--> statement-breakpoint
ALTER TABLE "notifications" ADD COLUMN "ref_type" text;--> statement-breakpoint
ALTER TABLE "notifications" ADD COLUMN "ref_id" uuid;--> statement-breakpoint
ALTER TABLE "notifications" ADD COLUMN "template_version" integer;--> statement-breakpoint
ALTER TABLE "notifications" ADD COLUMN "escalated_at" timestamp with time zone;--> statement-breakpoint
ALTER TABLE "notifications" ADD COLUMN "urgent" boolean DEFAULT false NOT NULL;--> statement-breakpoint
ALTER TABLE "notification_template_versions" ADD CONSTRAINT "notification_template_versions_template_id_notification_templates_id_fk" FOREIGN KEY ("template_id") REFERENCES "public"."notification_templates"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "notification_template_versions" ADD CONSTRAINT "notification_template_versions_author_id_users_id_fk" FOREIGN KEY ("author_id") REFERENCES "public"."users"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "user_notification_prefs" ADD CONSTRAINT "user_notification_prefs_user_id_users_id_fk" FOREIGN KEY ("user_id") REFERENCES "public"."users"("id") ON DELETE cascade ON UPDATE no action;
--> statement-breakpoint
DO $$
DECLARE t text;
BEGIN
  FOREACH t IN ARRAY ARRAY['notification_template_versions', 'user_notification_prefs']
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
CREATE INDEX IF NOT EXISTS notifications_tenant_read_idx ON notifications (tenant_id, user_id, read_at) WHERE read_at IS NULL;
