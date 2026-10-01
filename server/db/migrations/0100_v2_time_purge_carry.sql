-- review-time-tails · docs/v2/37 §11 `time.purge_sessions` · решение docs/v2/44 §17 Р-T1.
--
-- Написана руками: снимок drizzle не пересобирается начиная с `0056` (см. `0098`).
--
-- Уборка удаляет сегменты учёта времени старше 400 дней, а свёртка `time.rollup` пересчитывает
-- витрину пары «человек × элемент» из всех её сегментов заново. Без переноса первое же биение
-- после уборки (человек вернулся к уроку через год) пересчитало бы «Час на контент» только из
-- новых сегментов — год обучения исчез бы из витрины и из `lesson_progress`. Поэтому убранное
-- копится здесь, а свёртка считает «перенесено + сегменты». Новой таблицы нет — RLS
-- `learning_time_totals` (`0078`) действует на новые колонки как есть.
ALTER TABLE "learning_time_totals" ADD COLUMN "purged_content_seconds" integer NOT NULL DEFAULT 0;--> statement-breakpoint
ALTER TABLE "learning_time_totals" ADD COLUMN "purged_attempt_seconds" integer NOT NULL DEFAULT 0;--> statement-breakpoint
ALTER TABLE "learning_time_totals" ADD COLUMN "purged_discarded_seconds" integer NOT NULL DEFAULT 0;--> statement-breakpoint
ALTER TABLE "learning_time_totals" ADD COLUMN "purged_sessions_count" integer NOT NULL DEFAULT 0;--> statement-breakpoint
ALTER TABLE "learning_time_totals" ADD COLUMN "purged_first_started_at" timestamptz;--> statement-breakpoint
ALTER TABLE "learning_time_totals" ADD COLUMN "purged_last_activity_at" timestamptz;--> statement-breakpoint
ALTER TABLE "learning_time_totals" ADD CONSTRAINT "ltt_purged_chk" CHECK ("purged_content_seconds" >= 0 AND "purged_attempt_seconds" >= 0 AND "purged_discarded_seconds" >= 0 AND "purged_sessions_count" >= 0);
