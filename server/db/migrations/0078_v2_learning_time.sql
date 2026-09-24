-- docs/v2/45-plan.md PR-21 · docs/v2/37-review-delegation.md §3.6 (DDL), §3.7 (дополнения к
-- таблицам прогресса), §4 (сеанс измерения), §7.10–7.15 (алгоритм), §11 (фоновые задачи) ·
-- docs/v2/30-ai-interview.md §3.7 (`attempt_answers.input_mode`) · docs/v2/40 §2, §3 ·
-- сквозная проверка 22 (`docs/v2/42` §5): время считается биениями, а не разницей
-- «открыл — закрыл».
--
-- ── Что здесь и почему так ─────────────────────────────────────────────────────────────
-- `learning_time_sessions` — сегменты измеренного времени. Строка — не биение, а сегмент:
-- непрерывный отрезок активности одного экрана (`session_key`), в который складываются
-- биения каждые 30 секунд (`beats_count`). Это и есть «запись пачками» на уровне схемы:
-- 200 человек × 2 биения в минуту дают 200 обновлений строк, а не 400 новых строк в минуту.
-- `learning_time_totals` — витрина «человек × элемент × запись на курс», её считает фоном
-- задача `time.rollup`; горячий путь биения не трогает ни её, ни таблицы прогресса.
--
-- ── Колонки сверх DDL `37` §3.6 (решение Р-21.1, `46-progress.md`) ──────────────────────
-- * `created_at`, `updated_at` — общие поля каждой доменной таблицы (docs/02, преамбула);
--   по `updated_at` свёртка находит изменившиеся ключи.
-- * `last_seq`, `last_credit` — идемпотентность по `(session_key, seq)` (`37` §10, §12,
--   `41` §5.5): «повтор возвращает тот же `credited` и ничего не начисляет». Уникальность
--   `(tenant_id, session_key, segment_no)` защищает от повторной догрузки сегмента, но не
--   помнит биений: без номера последнего принятого биения и его зачёта повтор нечем узнать
--   и нечего вернуть.
-- * `media_seconds` — сколько из зачтённого пришло при скрытой вкладке от воспроизведения
--   медиа (`37` §7.11 «Фоновая вкладка»). Потолок «суммарно не более 1,5 × довжина медіа»
--   суммарный по элементу — без отдельного счётчика его не проверить.

-- ── 1. Сегменты измеренного времени (`37` §3.6) ─────────────────────────────────────────
CREATE TABLE "learning_time_sessions" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	"updated_at" timestamp with time zone DEFAULT now() NOT NULL,
	"tenant_id" uuid NOT NULL,
	"user_id" uuid NOT NULL,
	"enrollment_id" uuid,
	-- Элемент контента — мягкая полиморфная ссылка без FK (решение `44` В-11): сегмент —
	-- измерение, он переживает архивирование урока так же, как журнал.
	"subject_type" text NOT NULL,
	"subject_id" uuid NOT NULL,
	-- content — изучение материала, attempt — выполнение задания (`37` §7.12); виды одного
	-- элемента не пересекаются: открытый сегмент у пары «человек × элемент» один.
	"kind" text NOT NULL,
	"session_key" uuid NOT NULL,
	"segment_no" integer DEFAULT 1 NOT NULL,
	"beats_count" integer DEFAULT 0 NOT NULL,
	-- Время сервера: клиентское время в зачёт не входит (`37` §7.11). Исключение одно —
	-- офлайн-догрузка: серверных отметок у неё нет, время берётся из client_ts с поправкой
	-- на сдвиг часов клиента, и строка помечается is_offline_replay.
	"started_at" timestamp with time zone NOT NULL,
	"last_beat_at" timestamp with time zone NOT NULL,
	"closed_reason" text,
	"credited_seconds" integer DEFAULT 0 NOT NULL,
	"discarded_seconds" integer DEFAULT 0 NOT NULL,
	"media_seconds" integer DEFAULT 0 NOT NULL,
	"last_seq" integer DEFAULT 0 NOT NULL,
	"last_credit" integer DEFAULT 0 NOT NULL,
	"device" text,
	"is_offline_replay" boolean DEFAULT false NOT NULL,
	CONSTRAINT "lts_kind_chk" CHECK ("kind" IN ('content', 'attempt')),
	CONSTRAINT "lts_subject_chk" CHECK ("subject_type" IN ('lesson', 'quiz', 'workshop', 'track_node')),
	CONSTRAINT "lts_closed_chk" CHECK ("closed_reason" IS NULL OR "closed_reason" IN
		('completed', 'idle_timeout', 'segment_cap', 'daily_cap', 'navigated_away', 'session_end', 'stale')),
	-- Потолок сегмента 90 минут (`37` §7.11): больше в одной строке не бывает никогда
	CONSTRAINT "lts_credited_chk" CHECK ("credited_seconds" BETWEEN 0 AND 5400),
	CONSTRAINT "lts_discarded_chk" CHECK ("discarded_seconds" >= 0),
	CONSTRAINT "lts_media_chk" CHECK ("media_seconds" BETWEEN 0 AND "credited_seconds"),
	CONSTRAINT "lts_counters_chk" CHECK ("segment_no" >= 1 AND "beats_count" >= 0 AND "last_seq" >= 0 AND "last_credit" BETWEEN 0 AND 30),
	CONSTRAINT "lts_time_chk" CHECK ("last_beat_at" >= "started_at"),
	-- Защита от повторной догрузки (`37` §3.6)
	CONSTRAINT "uq_learning_time_sessions_segment" UNIQUE ("tenant_id", "session_key", "segment_no")
);
--> statement-breakpoint
ALTER TABLE "learning_time_sessions" ADD CONSTRAINT "learning_time_sessions_tenant_id_tenants_id_fk" FOREIGN KEY ("tenant_id") REFERENCES "public"."tenants"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "learning_time_sessions" ADD CONSTRAINT "learning_time_sessions_user_id_users_id_fk" FOREIGN KEY ("user_id") REFERENCES "public"."users"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "learning_time_sessions" ADD CONSTRAINT "learning_time_sessions_enrollment_id_enrollments_id_fk" FOREIGN KEY ("enrollment_id") REFERENCES "public"."enrollments"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
-- Полный индекс с tenant_id первым (контрактный тест 2): пара «человек × элемент × вид»
CREATE INDEX "idx_learning_time_sessions_tenant" ON "learning_time_sessions" USING btree ("tenant_id","user_id","subject_type","subject_id","kind");--> statement-breakpoint
-- Открытые сегменты — для `time.close_stale_sessions` раз в 5 минут
CREATE INDEX "idx_learning_time_sessions_open" ON "learning_time_sessions" USING btree ("tenant_id","last_beat_at") WHERE closed_reason IS NULL;--> statement-breakpoint
-- Изменившиеся сегменты — для `time.rollup` раз в 10 минут
CREATE INDEX "idx_learning_time_sessions_updated" ON "learning_time_sessions" USING btree ("tenant_id","updated_at");--> statement-breakpoint
-- «Открытых сеансов у человека по одной паре не больше одного» (`37` §4) — инвариантом базы,
-- а не только кода. Пара — «человек × элемент» без вида: виды одного элемента не пересекаются
-- (`37` §7.12), открытие попытки закрывает чтение материала (решение Р-21.4). Писатель берёт
-- advisory-блокировку пары, поэтому индекс в штатной работе не срабатывает — он ловит ошибку.
CREATE UNIQUE INDEX "uq_learning_time_sessions_open_pair" ON "learning_time_sessions" USING btree ("tenant_id","user_id","subject_type","subject_id") WHERE closed_reason IS NULL;--> statement-breakpoint
ALTER TABLE learning_time_sessions ENABLE ROW LEVEL SECURITY;--> statement-breakpoint
ALTER TABLE learning_time_sessions FORCE ROW LEVEL SECURITY;--> statement-breakpoint
CREATE POLICY tenant_isolation ON learning_time_sessions
  USING (tenant_id = nullif(current_setting('app.tenant_id', true), '')::uuid)
  WITH CHECK (tenant_id = nullif(current_setting('app.tenant_id', true), '')::uuid);--> statement-breakpoint
COMMENT ON TABLE "learning_time_sessions" IS 'Сегменты измеренного времени (docs/v2/37 §3.6, §7.10–7.12): биения каждые 30 с складываются в строку сегмента; пишет только server/services/learningTime*.ts.';--> statement-breakpoint
COMMENT ON COLUMN "learning_time_sessions"."last_seq" IS 'Номер последнего принятого биения сеанса — идемпотентность по (session_key, seq), docs/v2/37 §10, §12.';--> statement-breakpoint
COMMENT ON COLUMN "learning_time_sessions"."media_seconds" IS 'Зачтено при скрытой вкладке от воспроизведения медиа; суммарно по элементу не более 1,5 × длины медиа (docs/v2/37 §7.11).';--> statement-breakpoint

-- ── 2. Витрина суммарного времени (`37` §3.6, §7.12) ────────────────────────────────────
-- `nulls not distinct`: прохождение вне курса (`enrollment_id is null`) — тоже ровно одна
-- строка на ключ. Обычная уникальность считала бы два null разными и пропускала дубли, а
-- `on conflict` свёртки их бы не находил.
CREATE TABLE "learning_time_totals" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	"updated_at" timestamp with time zone DEFAULT now() NOT NULL,
	"tenant_id" uuid NOT NULL,
	"user_id" uuid NOT NULL,
	"enrollment_id" uuid,
	"subject_type" text NOT NULL,
	"subject_id" uuid NOT NULL,
	"confidence" text DEFAULT 'ok' NOT NULL,
	"content_seconds" integer DEFAULT 0 NOT NULL,
	"attempt_seconds" integer DEFAULT 0 NOT NULL,
	"discarded_seconds" integer DEFAULT 0 NOT NULL,
	"sessions_count" integer DEFAULT 0 NOT NULL,
	"first_started_at" timestamp with time zone,
	"last_activity_at" timestamp with time zone,
	CONSTRAINT "ltt_conf_chk" CHECK ("confidence" IN ('ok', 'partial', 'unreliable')),
	CONSTRAINT "ltt_subject_chk" CHECK ("subject_type" IN ('lesson', 'quiz', 'workshop', 'track_node')),
	CONSTRAINT "ltt_seconds_chk" CHECK ("content_seconds" >= 0 AND "attempt_seconds" >= 0 AND "discarded_seconds" >= 0 AND "sessions_count" >= 0),
	CONSTRAINT "uq_learning_time_totals_key" UNIQUE NULLS NOT DISTINCT ("tenant_id", "user_id", "subject_type", "subject_id", "enrollment_id")
);
--> statement-breakpoint
ALTER TABLE "learning_time_totals" ADD CONSTRAINT "learning_time_totals_tenant_id_tenants_id_fk" FOREIGN KEY ("tenant_id") REFERENCES "public"."tenants"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "learning_time_totals" ADD CONSTRAINT "learning_time_totals_user_id_users_id_fk" FOREIGN KEY ("user_id") REFERENCES "public"."users"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "learning_time_totals" ADD CONSTRAINT "learning_time_totals_enrollment_id_enrollments_id_fk" FOREIGN KEY ("enrollment_id") REFERENCES "public"."enrollments"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
CREATE INDEX "idx_learning_time_totals_tenant" ON "learning_time_totals" USING btree ("tenant_id","subject_type","subject_id");--> statement-breakpoint
ALTER TABLE learning_time_totals ENABLE ROW LEVEL SECURITY;--> statement-breakpoint
ALTER TABLE learning_time_totals FORCE ROW LEVEL SECURITY;--> statement-breakpoint
CREATE POLICY tenant_isolation ON learning_time_totals
  USING (tenant_id = nullif(current_setting('app.tenant_id', true), '')::uuid)
  WITH CHECK (tenant_id = nullif(current_setting('app.tenant_id', true), '')::uuid);--> statement-breakpoint
COMMENT ON TABLE "learning_time_totals" IS 'Витрина времени «человек × элемент × запись на курс» (docs/v2/37 §3.6, §7.12); пересчитывается задачей time.rollup, в горячем пути не пишется.';--> statement-breakpoint

-- ── 3. Дополнения к таблицам прогресса (`37` §3.7) ──────────────────────────────────────
-- Старые счётчики (`lesson_progress.seconds_spent`, `attempts.time_spent_sec`) не удаляются:
-- это «сырая» величина, материал для отладки алгоритма. Новые колонки — **учёт**, а не
-- правило прохождения: ни одно правило зачёта, дедлайна или лимита времени их не читает
-- (`attempts.deadline_at` и `params.timeLimitSec` остаются единственными носителями срока).
ALTER TABLE "lesson_progress" ADD COLUMN "content_seconds" integer DEFAULT 0 NOT NULL;--> statement-breakpoint
ALTER TABLE "lesson_progress" ADD COLUMN "discarded_seconds" integer DEFAULT 0 NOT NULL;--> statement-breakpoint
ALTER TABLE "lesson_progress" ADD COLUMN "sessions_count" integer DEFAULT 0 NOT NULL;--> statement-breakpoint
ALTER TABLE "attempts" ADD COLUMN "net_seconds" integer DEFAULT 0 NOT NULL;--> statement-breakpoint
ALTER TABLE "attempts" ADD COLUMN "discarded_seconds" integer DEFAULT 0 NOT NULL;--> statement-breakpoint
ALTER TABLE "workshop_submissions" ADD COLUMN "attempt_seconds" integer DEFAULT 0 NOT NULL;--> statement-breakpoint
ALTER TABLE "workshop_submissions" ADD COLUMN "content_seconds" integer DEFAULT 0 NOT NULL;--> statement-breakpoint

-- ── 4. Способ ввода ответа (`30` §3.7, решение `44` В-12) ───────────────────────────────
-- Голос — не новый тип вопроса, а способ ответа. Четыре значения — как в DDL `30` §3.7
-- (`44` В-12 в пересказе назвал три, без `video`; сценарий собеседования с `record_video`
-- даёт видеоответ, `30` §3.3 — исправлено пометкой в `44`).
ALTER TABLE "attempt_answers" ADD COLUMN "input_mode" text DEFAULT 'text' NOT NULL;--> statement-breakpoint
ALTER TABLE "attempt_answers" ADD CONSTRAINT "attempt_answers_input_mode_chk" CHECK ("input_mode" IN ('text', 'voice', 'video', 'file'));--> statement-breakpoint
-- Уже данные ответы на вопрос-файл — это файл, а не текст
UPDATE "attempt_answers" aa SET "input_mode" = 'file'
	FROM "questions" q WHERE q."id" = aa."question_id" AND q."kind" = 'file' AND aa."input_mode" <> 'file';--> statement-breakpoint

-- ── 5. Скоуп «чужое время» (`37` §2) ────────────────────────────────────────────────────
-- Эндпоинт `GET /learning/time/totals` появляется в этом PR, значит скоуп выдаётся ролям
-- (правило PR-03 в shared/domain/roles.ts): наставник и руководитель — в своей области,
-- администратор — во всём тенанте. Автор получает агрегат без имён с отчётом PR-22.
UPDATE roles SET scopes = array_cat(scopes, ARRAY['time.metrics.view'])
	WHERE is_system AND code IN ('mentor', 'manager', 'admin') AND NOT scopes @> ARRAY['time.metrics.view'];
