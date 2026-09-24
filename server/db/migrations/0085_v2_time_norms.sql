-- docs/v2/45-plan.md PR-22 · docs/v2/37-review-delegation.md §3.5 (DDL), §6.3 (форма нормы),
-- §7.13 (источники «Розрахункового часу»), §7.14 (флаг отклонения), §8 (`content_time_deviation`),
-- §9.3 (отчёт «План і факт часу»), §11 (`time.norms_recalc`) · docs/v2/40 §2, §3.
--
-- ── Что здесь и почему так ─────────────────────────────────────────────────────────────
-- `content_time_norms` — «Розрахунковий час» элемента: одна норма на урок, тест, практикум или
-- шаг траектории. Элемент — та же мягкая полиморфная пара, что у сегментов измерения
-- (`learning_time_sessions.subject_type/subject_id`, решение `44` В-11): норма и факт сходятся
-- по одному ключу. Строка хранит только агрегаты по элементу — медиану, p25, p75 и размер
-- выборки, ни одного человека: **отклонение — сигнал качества материала, а не оценка людей**
-- (§7.14). Ни балл, ни зачёт, ни рейтинг, ни начисление баллов эту таблицу не читают.
--
-- ── Отступления от DDL `37` §3.5 (решения Р-22.1…Р-22.3, `46-progress.md`) ───────────────
-- * `created_at`, `updated_at` — общие поля каждой доменной таблицы (docs/02, преамбула).
-- * `deviation_flag` по умолчанию `no_data`, а не `none`: новая норма ещё без выборки, а по
--   §7.14 при выборке меньше 10 флаг — `no_data`. `none` утверждал бы «измерили, отклонения нет».
-- * `ctn_author_source_chk`: у `author` и `observed` число обязано быть. `observed` — медиана,
--   принятая «Застосувати», замораживается в `author_seconds` в момент нажатия (Р-22.2):
--   иначе еженедельный пересчёт медианы молча менял бы норму, а §6.3 это запрещает.
-- * `ctn_observed_chk`: счётчики неотрицательны, p25 ≤ медиана ≤ p75.

CREATE TABLE "content_time_norms" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	"updated_at" timestamp with time zone DEFAULT now() NOT NULL,
	"tenant_id" uuid NOT NULL,
	"subject_type" text NOT NULL,
	"subject_id" uuid NOT NULL,
	"source" text DEFAULT 'auto' NOT NULL,
	"author_seconds" integer,
	"auto_seconds" integer,
	"observed_seconds" integer,
	"observed_p25" integer,
	"observed_p75" integer,
	"observed_sample" integer DEFAULT 0 NOT NULL,
	"deviation_flag" text DEFAULT 'no_data' NOT NULL,
	"recalculated_at" timestamp with time zone,
	"updated_by" uuid,
	CONSTRAINT "ctn_subject_chk" CHECK ("subject_type" IN ('lesson', 'quiz', 'workshop', 'track_node')),
	CONSTRAINT "ctn_source_chk" CHECK ("source" IN ('author', 'auto', 'observed')),
	-- Норма — от 1 минуты до 60 часов (форма §6.3: «Від 1 хвилини до 60 годин»)
	CONSTRAINT "ctn_author_chk" CHECK ("author_seconds" IS NULL OR "author_seconds" BETWEEN 60 AND 216000),
	CONSTRAINT "ctn_flag_chk" CHECK ("deviation_flag" IN ('none', 'too_fast', 'too_slow', 'no_data')),
	CONSTRAINT "ctn_author_source_chk" CHECK ("source" = 'auto' OR "author_seconds" IS NOT NULL),
	CONSTRAINT "ctn_observed_chk" CHECK ("observed_sample" >= 0 AND ("auto_seconds" IS NULL OR "auto_seconds" > 0)
		AND ("observed_seconds" IS NULL OR ("observed_seconds" >= 0 AND "observed_p25" <= "observed_seconds" AND "observed_seconds" <= "observed_p75"))),
	-- Одна норма на элемент (`37` §3.5)
	CONSTRAINT "uq_content_time_norms_subject" UNIQUE ("tenant_id", "subject_type", "subject_id")
);
--> statement-breakpoint
ALTER TABLE "content_time_norms" ADD CONSTRAINT "content_time_norms_tenant_id_tenants_id_fk" FOREIGN KEY ("tenant_id") REFERENCES "public"."tenants"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "content_time_norms" ADD CONSTRAINT "content_time_norms_updated_by_users_id_fk" FOREIGN KEY ("updated_by") REFERENCES "public"."users"("id") ON DELETE set null ON UPDATE no action;--> statement-breakpoint
-- Полный индекс с tenant_id первым (контрактный тест 2): экран норм фильтрует по отклонению
CREATE INDEX "idx_content_time_norms_tenant" ON "content_time_norms" USING btree ("tenant_id","subject_type","deviation_flag");--> statement-breakpoint
ALTER TABLE content_time_norms ENABLE ROW LEVEL SECURITY;--> statement-breakpoint
ALTER TABLE content_time_norms FORCE ROW LEVEL SECURITY;--> statement-breakpoint
CREATE POLICY tenant_isolation ON content_time_norms
  USING (tenant_id = nullif(current_setting('app.tenant_id', true), '')::uuid)
  WITH CHECK (tenant_id = nullif(current_setting('app.tenant_id', true), '')::uuid);--> statement-breakpoint
COMMENT ON TABLE "content_time_norms" IS '«Розрахунковий час» элемента контента (docs/v2/37 §3.5, §7.13–7.14): норма и агрегаты факта без людей; сигнал качества материала, в балл, зачёт и рейтинг не входит. Пишет только server/services/timeNorms.ts.';--> statement-breakpoint
COMMENT ON COLUMN "content_time_norms"."author_seconds" IS 'Норма, утверждённая автором: форма §6.3, «Орієнтовний час» материала или медиана, принятая «Застосувати» (source = observed) — заморожена в момент нажатия.';--> statement-breakpoint
COMMENT ON COLUMN "content_time_norms"."deviation_flag" IS 'Отклонение медианы факта от нормы (docs/v2/37 §7.14): too_slow > 2×, too_fast < 0,4×, no_data — выборка меньше 10 или нормы нет.';
