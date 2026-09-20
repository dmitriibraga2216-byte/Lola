-- Spec 19 (docs/19 Г-19.2, docs/02 «user_competencies», docs/32 §Б строка 16): нормализуем
-- source к каноническому составу assessment | task | manual (self/manager были ручной оценкой,
-- test — подтверждение курсом = завершённое задание) и запрещаем прочие значения CHECK'ом.
UPDATE "competency_assessments" SET "source" = 'manual' WHERE "source" IN ('self', 'manager', 'workshop', 'certification');--> statement-breakpoint
UPDATE "competency_assessments" SET "source" = 'task' WHERE "source" = 'test';--> statement-breakpoint
ALTER TABLE "competency_assessments" ADD CONSTRAINT "competency_assessments_source_competency_source" CHECK ("source" IN ('assessment', 'task', 'manual'));--> statement-breakpoint
-- «Ручна установка керівником — з причиною» (docs/19 Г-19.2): без причины manual не пишется.
ALTER TABLE "competency_assessments" ADD CONSTRAINT "competency_assessments_manual_reason" CHECK ("source" <> 'manual' OR ("comment" IS NOT NULL AND length(btrim("comment")) > 0));--> statement-breakpoint
ALTER TABLE "position_profiles" ADD COLUMN "goals" jsonb;--> statement-breakpoint
ALTER TABLE "position_profiles" ADD COLUMN "responsibilities" jsonb;--> statement-breakpoint
ALTER TABLE "position_profiles" ADD COLUMN "use_position_levels" boolean DEFAULT false NOT NULL;--> statement-breakpoint
CREATE INDEX "competency_assessments_tenant_id_valid_until_index" ON "competency_assessments" USING btree ("tenant_id","valid_until");