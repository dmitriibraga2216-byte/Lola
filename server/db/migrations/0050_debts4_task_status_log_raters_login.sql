CREATE TABLE "task_status_log" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	"updated_at" timestamp with time zone DEFAULT now() NOT NULL,
	"tenant_id" uuid NOT NULL,
	"user_id" uuid NOT NULL,
	"content_type" text NOT NULL,
	"content_id" uuid NOT NULL,
	"assignment_id" uuid,
	"enrollment_id" uuid,
	"status" text NOT NULL,
	"result" text,
	"source_kind" text NOT NULL,
	"source_id" uuid,
	"actor_id" uuid,
	"request_context" jsonb
);
--> statement-breakpoint
ALTER TABLE "sessions" ADD COLUMN "login_method" text;--> statement-breakpoint
ALTER TABLE "assessment_cycles" ADD COLUMN "rater_roles" jsonb DEFAULT '[]' NOT NULL;--> statement-breakpoint
ALTER TABLE "assessment_tasks" ADD COLUMN "weight" numeric(4, 2) DEFAULT '1' NOT NULL;--> statement-breakpoint
ALTER TABLE "assessment_tasks" ADD COLUMN "is_anonymous" boolean DEFAULT false NOT NULL;--> statement-breakpoint
ALTER TABLE "assessment_tasks" ADD COLUMN "items" jsonb;--> statement-breakpoint
ALTER TABLE "task_status_log" ADD CONSTRAINT "task_status_log_user_id_users_id_fk" FOREIGN KEY ("user_id") REFERENCES "public"."users"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
CREATE INDEX "task_status_log_tenant_id_created_at_index" ON "task_status_log" USING btree ("tenant_id","created_at" DESC NULLS LAST);--> statement-breakpoint
CREATE INDEX "task_status_log_tenant_id_user_id_content_type_content_id_created_at_index" ON "task_status_log" USING btree ("tenant_id","user_id","content_type","content_id","created_at" DESC NULLS LAST);--> statement-breakpoint
CREATE INDEX "task_status_log_tenant_id_assignment_id_index" ON "task_status_log" USING btree ("tenant_id","assignment_id");--> statement-breakpoint
-- Перечисления и допустимые значения (docs/02): статус — из пяти enrollment_status, в журнале только завершения
ALTER TABLE "task_status_log" ADD CONSTRAINT "task_status_log_content_type_check" CHECK ("content_type" IN ('course', 'training_program', 'resource', 'test', 'complex_test', 'workshop', 'poll', 'assessment', 'check_list', 'meetup', 'webinar', 'notice', 'trajectory'));--> statement-breakpoint
ALTER TABLE "task_status_log" ADD CONSTRAINT "task_status_log_status_check" CHECK ("status" IN ('done', 'failed'));--> statement-breakpoint
-- Таблицы тенанта — RLS обязателен (CLAUDE.md п. 1)
ALTER TABLE task_status_log ENABLE ROW LEVEL SECURITY;--> statement-breakpoint
ALTER TABLE task_status_log FORCE ROW LEVEL SECURITY;--> statement-breakpoint
CREATE POLICY tenant_isolation ON task_status_log
  USING (tenant_id = nullif(current_setting('app.tenant_id', true), '')::uuid)
  WITH CHECK (tenant_id = nullif(current_setting('app.tenant_id', true), '')::uuid);--> statement-breakpoint
-- Роли оценщиков по docs/02 (Г-20.1): mentor → external («наставник або таємний покупець»), + functional_manager
UPDATE "assessment_tasks" SET "rater_kind" = 'external' WHERE "rater_kind" = 'mentor';--> statement-breakpoint
UPDATE "assessment_cycles" SET "rater_kinds" = array_replace("rater_kinds", 'mentor', 'external') WHERE 'mentor' = ANY("rater_kinds");--> statement-breakpoint
ALTER TABLE "assessment_tasks" ADD CONSTRAINT "assessment_tasks_rater_kind_check" CHECK ("rater_kind" IN ('self', 'manager', 'functional_manager', 'peer', 'subordinate', 'external'));--> statement-breakpoint
-- Знімок ваги/анонімності для вже створених анкет — за ролями за замовчуванням (Г-20.1, Г-20.2)
UPDATE "assessment_tasks" SET "weight" = CASE "rater_kind" WHEN 'manager' THEN 2 WHEN 'self' THEN 0 ELSE 1 END, "is_anonymous" = ("rater_kind" IN ('peer', 'subordinate'));--> statement-breakpoint
ALTER TABLE "sessions" ADD CONSTRAINT "sessions_login_method_check" CHECK ("login_method" IS NULL OR "login_method" IN ('otp', 'otp_sms', 'otp_telegram', 'otp_email', 'password', 'password_otp', 'google', 'invite', 'impersonation'));
