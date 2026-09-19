DROP INDEX "enrollments_tenant_id_due_at_index";--> statement-breakpoint
ALTER TABLE "sessions" ADD COLUMN "request_context" jsonb;--> statement-breakpoint
ALTER TABLE "audit_log" ADD COLUMN "request_context" jsonb;--> statement-breakpoint
ALTER TABLE "security_log" ADD COLUMN "request_context" jsonb;--> statement-breakpoint
ALTER TABLE "import_jobs" ADD COLUMN "request_context" jsonb;--> statement-breakpoint
ALTER TABLE "enrollment_events" ADD COLUMN "request_context" jsonb;--> statement-breakpoint
ALTER TABLE "automation_runs" ADD COLUMN "request_context" jsonb;--> statement-breakpoint
ALTER TABLE "notifications" ADD COLUMN "request_context" jsonb;--> statement-breakpoint
ALTER TABLE "goal_status_log" ADD COLUMN "request_context" jsonb;--> statement-breakpoint
CREATE INDEX "enrollments_tenant_id_due_at_index" ON "enrollments" USING btree ("tenant_id","due_at") WHERE "enrollments"."status" in ('not_started', 'in_progress') and "enrollments"."cancelled_at" is null;--> statement-breakpoint
-- Единый технический контекст журналов (CLAUDE.md п. 14, формат docs/02): старые ip/user_agent переносятся в request_context
UPDATE "audit_log" SET "request_context" = jsonb_strip_nulls(jsonb_build_object('ip', host("ip"), 'user_agent', "user_agent")) WHERE "request_context" IS NULL AND ("ip" IS NOT NULL OR "user_agent" IS NOT NULL);--> statement-breakpoint
UPDATE "security_log" SET "request_context" = jsonb_strip_nulls(jsonb_build_object('ip', host("ip"), 'user_agent', "user_agent")) WHERE "request_context" IS NULL AND ("ip" IS NOT NULL OR "user_agent" IS NOT NULL);--> statement-breakpoint
UPDATE "sessions" SET "request_context" = jsonb_strip_nulls(jsonb_build_object('ip', host("ip"), 'user_agent', "user_agent")) WHERE "request_context" IS NULL AND ("ip" IS NOT NULL OR "user_agent" IS NOT NULL);--> statement-breakpoint
-- Уровень события журнала безопасности: security_severity из docs/02 (info | warning | critical), градация — docs/16 §15
ALTER TABLE "security_log" ADD COLUMN "severity" text DEFAULT 'info' NOT NULL;--> statement-breakpoint
ALTER TABLE "security_log" ADD CONSTRAINT "security_log_severity_security_severity" CHECK ("severity" IN ('info', 'warning', 'critical'));--> statement-breakpoint
UPDATE "security_log" SET "severity" = 'critical' WHERE "event" LIKE 'impersonation.%';
