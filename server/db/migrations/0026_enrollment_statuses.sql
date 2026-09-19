ALTER TABLE "enrollments" ADD COLUMN "cancelled_at" timestamp with time zone;--> statement-breakpoint
ALTER TABLE "program_enrollments" ADD COLUMN "cancelled_at" timestamp with time zone;--> statement-breakpoint
ALTER TABLE "program_enrollments" ADD COLUMN "requested_at" timestamp with time zone;--> statement-breakpoint
-- Пять статусов прохождения (CLAUDE.md п. 12, docs/02 enrollment_status): not_assigned | not_started | in_progress | done | failed.
-- Остальное — признаки: «заплановано» = starts_at > now(); автозакрытие по сроку = failed + expired_at; снятие = cancelled_at.
UPDATE "enrollments" SET "cancelled_at" = coalesce("updated_at", now()), "status" = CASE WHEN "started_at" IS NULL THEN 'not_started' ELSE 'in_progress' END WHERE "status" = 'cancelled';--> statement-breakpoint
UPDATE "enrollments" SET "status" = 'not_started' WHERE "status" = 'scheduled';--> statement-breakpoint
UPDATE "enrollments" SET "status" = 'done' WHERE "status" = 'completed';--> statement-breakpoint
UPDATE "enrollments" SET "status" = 'failed', "expired_at" = coalesce("expired_at", "updated_at", now()) WHERE "status" = 'expired';--> statement-breakpoint
ALTER TABLE "enrollments" ADD CONSTRAINT "enrollments_status_enrollment_status" CHECK ("status" IN ('not_assigned', 'not_started', 'in_progress', 'done', 'failed'));--> statement-breakpoint
DROP INDEX IF EXISTS "enrollments_tenant_id_due_at_index";--> statement-breakpoint
CREATE INDEX "enrollments_tenant_id_due_at_index" ON "enrollments" USING btree ("tenant_id","due_at") WHERE "status" in ('not_started', 'in_progress') and "cancelled_at" is null;--> statement-breakpoint
UPDATE "program_enrollments" SET "cancelled_at" = coalesce("updated_at", now()), "status" = CASE WHEN "started_at" IS NULL THEN 'not_started' ELSE 'in_progress' END WHERE "status" = 'cancelled';--> statement-breakpoint
UPDATE "program_enrollments" SET "requested_at" = coalesce("created_at", now()), "status" = 'not_assigned' WHERE "status" = 'requested';--> statement-breakpoint
UPDATE "program_enrollments" SET "status" = 'done' WHERE "status" = 'completed';--> statement-breakpoint
UPDATE "program_enrollments" SET "status" = 'failed' WHERE "status" = 'expired';--> statement-breakpoint
ALTER TABLE "program_enrollments" ADD CONSTRAINT "program_enrollments_status_enrollment_status" CHECK ("status" IN ('not_assigned', 'not_started', 'in_progress', 'done', 'failed'));
