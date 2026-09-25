-- docs/v2/45-plan.md PR-34 · docs/v2/38-people-extensions.md §3.1 (`users.timezone`), §3.3 (DDL
-- ленты), §7.9 (закрытый список событий), §7.10 (часовой пояс, агрегат, уровни), §7.11 (400 дней,
-- доступ к чужой ленте), §11 (`activity.purge`, `activity.aggregate`), §13 критерии 11 и 12 ·
-- docs/v2/40 §2.11, §3.
--
-- ── Что здесь и почему так ─────────────────────────────────────────────────────────────
-- Лента активности отвечает на вопрос «людина вчилася?» за год. Событие пишется в той же
-- транзакции, что и действие (урок зачтён, попытка сдана, сертификат выдан…), и в момент вставки
-- получает **снимок часового пояса** человека и **свой локальный день** — они больше никогда не
-- пересчитываются: перевод на точку в другом поясе не переписывает прошлую карту (§7.10, §12).
-- Суточный агрегат `user_activity_daily` хранится бессрочно: события живут 400 дней и уходят
-- задачей `activity.purge`, а карта за прошлые годы строится по агрегату (критерий 12).
--
-- ── Отступления от DDL `38` §3.3 (решения Р-34.1…Р-34.4, `46-progress.md`) ───────────────
-- * `user_activity_events.seconds_spent` не заводится: время обучения уже измеряет учёт времени
--   биениями (`learning_time_sessions`, PR-21), и копия его в событии завела бы второй источник
--   времени. Секунды дня в агрегат сводит задача `activity.aggregate` из сегментов (Р-34.2).
-- * `user_activity_events.created_at` — момент записи. `occurred_at` у двух видов — момент
--   действия самого человека, а не момент записи: оценка попытки ложится в день сдачи, принятое
--   замечание — в день жалобы (Р-34.3). По `created_at` видно, когда событие фактически пришло.
-- * `location_id` — `on delete set null`: удаление точки не должно упираться в историю ленты,
--   снимок пояса (`tz`) остаётся в строке.
-- * `idx_user_activity_events_purge (tenant_id, occurred_at)` сверх DDL: без него ночная уборка
--   читает все события тенанта, а не только старые.
-- * У агрегата отдельного `idx_user_activity_daily_tenant (tenant_id, user_id, local_date desc)`
--   нет: уникальный ключ `(tenant_id, user_id, local_date)` уже этот индекс, btree читается и в
--   обратном порядке, а второй такой же индекс только удваивает запись.
-- * `request_context` у событий нет (Р-34.4): лента — производная проекция уже зажурналированных
--   действий (`enrollment_events`, `task_status_log`, `attempt_results`, `audit_log` пишут контекст
--   сами), а не журнал доказательства «кто и откуда»; копия IP и браузера на 400 дней — лишние ПД.

-- ── 1. users.timezone — override пояса точки для удалённых (`38` §3.1) ────────────────────
-- Пустое значение — «по точке» (§7.10). Проверка — через сам Postgres: неизвестное ему имя пояса
-- не сохраняется вовсе («time zone not recognized»), иначе оно ломало бы запись события позже.
-- `timezone(text, timestamptz)` — immutable, выражение допустимо в check.
ALTER TABLE "users" ADD COLUMN "timezone" text;--> statement-breakpoint
ALTER TABLE "users" ADD CONSTRAINT "users_timezone_chk" CHECK ("timezone" IS NULL OR (timestamptz '2000-01-01 00:00:00+00' AT TIME ZONE "timezone") IS NOT NULL);--> statement-breakpoint
COMMENT ON COLUMN "users"."timezone" IS 'IANA-пояс человека, только для удалённых; null — пояс точки размещения (docs/v2/38 §3.1, §7.10). Первое звено цепочки personTimezone()';--> statement-breakpoint

-- ── 2. user_activity_events — событие со снимком пояса и локальным днём (`38` §3.3) ────────
CREATE TABLE "user_activity_events" (
	"id" bigserial PRIMARY KEY NOT NULL,
	"tenant_id" uuid NOT NULL,
	"user_id" uuid NOT NULL,
	"kind" text NOT NULL,
	"ref_entity" text,
	"ref_id" uuid,
	"location_id" uuid,
	"tz" text NOT NULL,
	"local_date" date NOT NULL,
	"occurred_at" timestamp with time zone DEFAULT now() NOT NULL,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	CONSTRAINT "user_activity_events_kind_chk" CHECK ("kind" IN ('lesson_completed', 'attempt_submitted', 'attempt_graded', 'enrollment_started', 'enrollment_completed', 'workshop_submitted', 'checklist_run_completed', 'knowledge_read', 'survey_submitted', 'certificate_issued', 'review_graded', 'content_issue_accepted'))
);--> statement-breakpoint
ALTER TABLE "user_activity_events" ADD CONSTRAINT "user_activity_events_tenant_id_tenants_id_fk" FOREIGN KEY ("tenant_id") REFERENCES "public"."tenants"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "user_activity_events" ADD CONSTRAINT "user_activity_events_user_id_users_id_fk" FOREIGN KEY ("user_id") REFERENCES "public"."users"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "user_activity_events" ADD CONSTRAINT "user_activity_events_location_id_locations_id_fk" FOREIGN KEY ("location_id") REFERENCES "public"."locations"("id") ON DELETE set null ON UPDATE no action;--> statement-breakpoint
-- tenant-first, непартиальные (контрактный тест №2): карта человека за год и ночная уборка
CREATE INDEX "idx_user_activity_events_tenant" ON "user_activity_events" USING btree ("tenant_id","user_id","local_date" DESC);--> statement-breakpoint
CREATE INDEX "idx_user_activity_events_purge" ON "user_activity_events" USING btree ("tenant_id","occurred_at");--> statement-breakpoint
ALTER TABLE user_activity_events ENABLE ROW LEVEL SECURITY;--> statement-breakpoint
ALTER TABLE user_activity_events FORCE ROW LEVEL SECURITY;--> statement-breakpoint
CREATE POLICY tenant_isolation ON user_activity_events
  USING (tenant_id = nullif(current_setting('app.tenant_id', true), '')::uuid)
  WITH CHECK (tenant_id = nullif(current_setting('app.tenant_id', true), '')::uuid);--> statement-breakpoint
COMMENT ON TABLE "user_activity_events" IS 'Лента активности (docs/v2/38 §3.3, §7.9): закрытый список из 12 видов, вход в систему событием не является. Хранится 400 дней — activity.purge (§7.11)';--> statement-breakpoint
COMMENT ON COLUMN "user_activity_events"."tz" IS 'Снимок пояса на момент события: users.timezone → точка размещения на дату события → точка вакансии кандидата → тенант (§7.10). Не пересчитывается';--> statement-breakpoint
COMMENT ON COLUMN "user_activity_events"."local_date" IS 'Локальный день человека: (occurred_at at time zone tz)::date, считается один раз при вставке. Граница суток — его полночь, не UTC и не тенанта';--> statement-breakpoint
COMMENT ON COLUMN "user_activity_events"."occurred_at" IS 'Момент действия самого человека: для attempt_graded — сдача попытки, для content_issue_accepted — подача замечания (Р-34.3)';--> statement-breakpoint

-- ── 3. user_activity_daily — суточный агрегат, бессрочно (`38` §3.3, §7.10, §7.11) ─────────
-- Счётчик, разбивка по видам и уровень обновляются в транзакции события; секунды дня сводит из
-- сегментов учёта времени задача `activity.aggregate`. Писатели трогают разные колонки.
CREATE TABLE "user_activity_daily" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"tenant_id" uuid NOT NULL,
	"user_id" uuid NOT NULL,
	"local_date" date NOT NULL,
	"events_count" integer DEFAULT 0 NOT NULL,
	"seconds_spent" integer DEFAULT 0 NOT NULL,
	"kinds" jsonb DEFAULT '{}'::jsonb NOT NULL,
	"level" smallint DEFAULT 0 NOT NULL,
	"recalced_at" timestamp with time zone DEFAULT now() NOT NULL,
	CONSTRAINT "uq_user_activity_daily_day" UNIQUE("tenant_id","user_id","local_date"),
	CONSTRAINT "user_activity_daily_counts_chk" CHECK ("events_count" >= 0 AND "seconds_spent" >= 0),
	CONSTRAINT "user_activity_daily_level_chk" CHECK ("level" BETWEEN 0 AND 4)
);--> statement-breakpoint
ALTER TABLE "user_activity_daily" ADD CONSTRAINT "user_activity_daily_tenant_id_tenants_id_fk" FOREIGN KEY ("tenant_id") REFERENCES "public"."tenants"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "user_activity_daily" ADD CONSTRAINT "user_activity_daily_user_id_users_id_fk" FOREIGN KEY ("user_id") REFERENCES "public"."users"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE user_activity_daily ENABLE ROW LEVEL SECURITY;--> statement-breakpoint
ALTER TABLE user_activity_daily FORCE ROW LEVEL SECURITY;--> statement-breakpoint
CREATE POLICY tenant_isolation ON user_activity_daily
  USING (tenant_id = nullif(current_setting('app.tenant_id', true), '')::uuid)
  WITH CHECK (tenant_id = nullif(current_setting('app.tenant_id', true), '')::uuid);--> statement-breakpoint
COMMENT ON TABLE "user_activity_daily" IS 'Суточный агрегат ленты (docs/v2/38 §3.3): строка на человеко-день, хранится бессрочно — карта за прошлые годы после activity.purge строится по нему (§7.11, критерий 12)';--> statement-breakpoint
COMMENT ON COLUMN "user_activity_daily"."level" IS 'Заливка клетки 0…4 по числу событий, не по времени (§7.10): 0 — нет, 1 — 1–2, 2 — 3–5, 3 — 6–10, 4 — больше 10';--> statement-breakpoint
COMMENT ON COLUMN "user_activity_daily"."seconds_spent" IS 'Время в обучении за локальный день — сумма зачтённых секунд сегментов учёта времени (learning_time_sessions, PR-21); заливку не определяет';--> statement-breakpoint

-- ── 4. Скоуп чужой ленты руководителю точки (`38` §2, §7.11) ─────────────────────────────
-- Скоуп заведён PR-03 и был только у администратора свежих тенантов. Руководитель точки видит
-- ленту людей своей точки — в области своей роли. Наставнику скоуп не выдаётся: его право уже
-- (люди из его очереди проверки, 90 дней) — это право по данным, а не по роли (Р-34.5): скоуп
-- на точку открыл бы ему всю точку на всю глубину. Администратору заведённых тенантов —
-- догоняющая выдача, как в PR-32: его набор в БД собирался до PR-03.
UPDATE roles SET scopes = scopes || ARRAY(
	SELECT s FROM unnest(ARRAY['person.activity.view_others']::text[]) AS s
	WHERE NOT s = ANY(roles.scopes)
)
WHERE is_system AND code IN ('manager', 'admin');
