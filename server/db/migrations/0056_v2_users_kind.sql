-- v2 PR-04 (docs/v2/45-plan.md), состав задан решением docs/v2/44-decisions.md В-14 — ни строкой больше.
-- Кандидат и сотрудник — одна запись users с разным kind (инвариант пакета, docs/v2/28 §2):
-- перевод кандидата в штат меняет kind, а не заводит вторую строку.
-- Откат — только вперёд, выключением tenants.candidates_enabled; `drop column kind` запрещён.
ALTER TABLE "users" ADD COLUMN "kind" text DEFAULT 'employee' NOT NULL;--> statement-breakpoint
ALTER TABLE "users" ADD CONSTRAINT "users_kind_chk" CHECK ("users"."kind" in ('employee', 'candidate'));--> statement-breakpoint
-- Списки сотрудников — самая частая выборка людей; кандидаты в этот индекс не попадают.
CREATE INDEX "users_tenant_status_employee_idx" ON "users" USING btree ("tenant_id","status") WHERE kind = 'employee';--> statement-breakpoint
-- Рекрутинг выключен, пока тенант его не включил (docs/v2/28 §3): до включения кандидатов в тенанте нет.
ALTER TABLE "tenants" ADD COLUMN "candidates_enabled" boolean DEFAULT false NOT NULL;
