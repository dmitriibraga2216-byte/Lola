CREATE TABLE "org_conflicts" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	"updated_at" timestamp with time zone DEFAULT now() NOT NULL,
	"tenant_id" uuid NOT NULL,
	"user_id" uuid,
	"kind" text NOT NULL,
	"source" text DEFAULT 'manual' NOT NULL,
	"import_job_id" uuid,
	"details" jsonb DEFAULT '{}' NOT NULL,
	"actor_id" uuid,
	"request_context" jsonb,
	"resolved_at" timestamp with time zone,
	"resolved_by" uuid
);
--> statement-breakpoint
CREATE TABLE "task_access_log" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	"updated_at" timestamp with time zone DEFAULT now() NOT NULL,
	"tenant_id" uuid NOT NULL,
	"user_id" uuid NOT NULL,
	"content_type" text NOT NULL,
	"content_id" uuid NOT NULL,
	"title" text,
	"assignment_id" uuid,
	"enrollment_id" uuid,
	"action" text DEFAULT 'open' NOT NULL,
	"request_context" jsonb
);
--> statement-breakpoint
ALTER TABLE "report_exports" ADD COLUMN "active_role_id" uuid;--> statement-breakpoint
ALTER TABLE "org_conflicts" ADD CONSTRAINT "org_conflicts_user_id_users_id_fk" FOREIGN KEY ("user_id") REFERENCES "public"."users"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "task_access_log" ADD CONSTRAINT "task_access_log_user_id_users_id_fk" FOREIGN KEY ("user_id") REFERENCES "public"."users"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
CREATE INDEX "org_conflicts_tenant_id_created_at_index" ON "org_conflicts" USING btree ("tenant_id","created_at" DESC NULLS LAST);--> statement-breakpoint
CREATE INDEX "org_conflicts_tenant_id_user_id_index" ON "org_conflicts" USING btree ("tenant_id","user_id");--> statement-breakpoint
CREATE INDEX "task_access_log_tenant_id_created_at_index" ON "task_access_log" USING btree ("tenant_id","created_at" DESC NULLS LAST);--> statement-breakpoint
CREATE INDEX "task_access_log_tenant_id_content_type_content_id_created_at_index" ON "task_access_log" USING btree ("tenant_id","content_type","content_id","created_at" DESC NULLS LAST);--> statement-breakpoint
CREATE INDEX "task_access_log_tenant_id_user_id_created_at_index" ON "task_access_log" USING btree ("tenant_id","user_id","created_at" DESC NULLS LAST);;--> statement-breakpoint
-- Перечисления и допустимые значения
ALTER TABLE "task_access_log" ADD CONSTRAINT "task_access_log_content_type_content_type" CHECK ("content_type" IN ('course', 'training_program', 'resource', 'test', 'complex_test', 'workshop', 'poll', 'assessment', 'check_list', 'meetup', 'webinar'));--> statement-breakpoint
ALTER TABLE "task_access_log" ADD CONSTRAINT "task_access_log_action_check" CHECK ("action" IN ('open', 'download'));--> statement-breakpoint
ALTER TABLE "org_conflicts" ADD CONSTRAINT "org_conflicts_kind_check" CHECK ("kind" IN ('double_unit', 'placement_replaced', 'manager_self', 'manager_cycle'));--> statement-breakpoint
ALTER TABLE "org_conflicts" ADD CONSTRAINT "org_conflicts_source_check" CHECK ("source" IN ('manual', 'import'));--> statement-breakpoint
-- Таблицы тенанта — RLS обязателен (CLAUDE.md п. 1)
ALTER TABLE task_access_log ENABLE ROW LEVEL SECURITY;--> statement-breakpoint
ALTER TABLE task_access_log FORCE ROW LEVEL SECURITY;--> statement-breakpoint
CREATE POLICY tenant_isolation ON task_access_log
  USING (tenant_id = nullif(current_setting('app.tenant_id', true), '')::uuid)
  WITH CHECK (tenant_id = nullif(current_setting('app.tenant_id', true), '')::uuid);--> statement-breakpoint
ALTER TABLE org_conflicts ENABLE ROW LEVEL SECURITY;--> statement-breakpoint
ALTER TABLE org_conflicts FORCE ROW LEVEL SECURITY;--> statement-breakpoint
CREATE POLICY tenant_isolation ON org_conflicts
  USING (tenant_id = nullif(current_setting('app.tenant_id', true), '')::uuid)
  WITH CHECK (tenant_id = nullif(current_setting('app.tenant_id', true), '')::uuid);
