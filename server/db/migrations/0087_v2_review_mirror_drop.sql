-- docs/v2/45-plan.md PR-20 · решение docs/v2/44-decisions.md В-2 (переходный период истёк)
--
-- `review_queue_items` (0066, PR-18 #100) стала единственным источником истины о состоянии
-- проверки, а с делегированием, маршрутизацией и SLA (0080, PR-19 #118) — и полноценной. Три
-- колонки `workshop_submissions` были её зеркалом «для совместимости, через один PR после
-- перевода читателей» — срок назван в самом В-2, чтобы «переходный период» не стал вечным.
-- Читатели переведены (`server/services/workshops.ts` — узкий фильтр `/review/workshops` и
-- `workshopSlaScan`), зеркало снимается. `rework_count` и `status` остаются: это состояние
-- самой сдачи, а не проверки.
ALTER TABLE "workshop_submissions" DROP CONSTRAINT "workshop_submissions_reviewer_id_users_id_fk";--> statement-breakpoint
ALTER TABLE "workshop_submissions" DROP COLUMN "reviewer_id";--> statement-breakpoint
ALTER TABLE "workshop_submissions" DROP COLUMN "claimed_at";--> statement-breakpoint
ALTER TABLE "workshop_submissions" DROP COLUMN "sla_due_at";
