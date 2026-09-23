-- docs/v2/45-plan.md PR-18 · docs/14-certification.md §3.3 · docs/v2/37-review-delegation.md §3.1 ·
-- docs/v2/39-patches.md П-13 · решения docs/v2/44-decisions.md В-2 (таблица, а не витрина) и
-- В-15 (`/review/queue` — единая очередь поверх неё).
--
-- Номер: план называл 0069, но 0065 занял параллельный PR-14, а в main на момент ветки был 0064.
--
-- Почему `create table`, а не `alter` из `37` §3.1: объекта не существует вовсе — ни таблицы,
-- ни представления, ни матвью (`43` §4.1 Р-3, проверено information_schema). «Повышение витрины
-- до таблицы» на деле — создание с нуля, поэтому миграции-конвертации здесь нет.
--
-- Почему таблица, а не матвью «раз в минуту» из `14` §3.3: на строку очереди ссылаются
-- делегирование (`review_delegations.queue_item_id`), события SLA, «каким правилом назначено»
-- и суточная статистика проверяющего. У строки, собранной запросом, устойчивого
-- идентификатора нет — она исчезает при следующем вызове. Плюс у витрины «раз в минуту» есть
-- собственный дефект: два наставника берут одну работу в окне между обновлениями.
--
-- Двух FK здесь нет намеренно: `delegation_id` → `review_delegations` и `assigned_by_rule_id`
-- → `review_routing_rules` смотрят на таблицы, которых ещё нет (PR-19). Их ставит развязка
-- PR-19 — тот же приём, что в 0064 с `users.vacancy_id` (цикл `40` §5 0022).

CREATE TABLE "review_queue_items" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	"updated_at" timestamp with time zone DEFAULT now() NOT NULL,
	"tenant_id" uuid NOT NULL,
	-- Идентичность работы. Одна ось вместо двух: В-2 называл её `source` (4 значения),
	-- `37` §3.1 — `task_type` (те же 4 под именами интерфейса + ai_interview_review).
	-- Значение указывает и таблицу источника, и подпись в интерфейсе (docs/02, review_task_type).
	"task_type" text NOT NULL,
	"source_id" uuid NOT NULL,
	"user_id" uuid NOT NULL,
	-- Снимок `users.kind` на момент постановки в очередь: фильтр вида применяется один раз,
	-- в enqueueReview(), а не при каждом чтении очереди (docs/v2/44 В-8 × В-2).
	"subject_kind" text DEFAULT 'employee' NOT NULL,
	-- Снимки для списка: «Назва завдання», «Трек», «Філії», посада. Переименование материала
	-- не переписывает очередь, а экран рисуется одним запросом без join к четырём источникам.
	"task_title" text,
	"track_id" uuid,
	"location_id" uuid,
	"position_id" uuid,
	"submitted_at" timestamp with time zone DEFAULT now() NOT NULL,
	"completed_at" timestamp with time zone,
	"attempt_no" integer DEFAULT 1 NOT NULL,
	"estimated_seconds" integer,
	"content_seconds" integer DEFAULT 0 NOT NULL,
	"attempt_seconds" integer DEFAULT 0 NOT NULL,
	"time_confidence" text DEFAULT 'ok' NOT NULL,
	"status" text DEFAULT 'waiting' NOT NULL,
	"priority" integer DEFAULT 0 NOT NULL,
	"assigned_reviewer_id" uuid,
	"assigned_at" timestamp with time zone,
	"assigned_by_rule_id" uuid,
	"delegation_id" uuid,
	"origin_reviewer_id" uuid,
	"delegation_depth" integer DEFAULT 0 NOT NULL,
	"sla_hours" integer DEFAULT 48 NOT NULL,
	"sla_due_at" timestamp with time zone,
	"sla_warned_at" timestamp with time zone,
	"sla_breached_at" timestamp with time zone,
	"escalated_at" timestamp with time zone,
	"escalated_to_id" uuid,
	CONSTRAINT "rqi_task_type_chk" CHECK ("task_type" IN ('quiz_open_answer', 'workshop', 'offline_confirm', 'survey_open', 'ai_interview_review')),
	CONSTRAINT "rqi_subject_kind_chk" CHECK ("subject_kind" IN ('employee', 'candidate')),
	CONSTRAINT "rqi_status_chk" CHECK ("status" IN ('waiting', 'in_review', 'done')),
	CONSTRAINT "rqi_time_confidence_chk" CHECK ("time_confidence" IN ('ok', 'partial', 'unreliable')),
	CONSTRAINT "rqi_depth_chk" CHECK ("delegation_depth" BETWEEN 0 AND 2),
	CONSTRAINT "rqi_sla_hours_chk" CHECK ("sla_hours" BETWEEN 1 AND 720),
	CONSTRAINT "rqi_attempt_no_chk" CHECK ("attempt_no" >= 1),
	CONSTRAINT "rqi_seconds_chk" CHECK ("content_seconds" >= 0 AND "attempt_seconds" >= 0 AND ("estimated_seconds" IS NULL OR "estimated_seconds" BETWEEN 60 AND 216000))
);
--> statement-breakpoint
ALTER TABLE "review_queue_items" ADD CONSTRAINT "review_queue_items_tenant_id_tenants_id_fk" FOREIGN KEY ("tenant_id") REFERENCES "public"."tenants"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "review_queue_items" ADD CONSTRAINT "review_queue_items_user_id_users_id_fk" FOREIGN KEY ("user_id") REFERENCES "public"."users"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "review_queue_items" ADD CONSTRAINT "review_queue_items_location_id_locations_id_fk" FOREIGN KEY ("location_id") REFERENCES "public"."locations"("id") ON DELETE set null ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "review_queue_items" ADD CONSTRAINT "review_queue_items_position_id_positions_id_fk" FOREIGN KEY ("position_id") REFERENCES "public"."positions"("id") ON DELETE set null ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "review_queue_items" ADD CONSTRAINT "review_queue_items_assigned_reviewer_id_users_id_fk" FOREIGN KEY ("assigned_reviewer_id") REFERENCES "public"."users"("id") ON DELETE set null ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "review_queue_items" ADD CONSTRAINT "review_queue_items_origin_reviewer_id_users_id_fk" FOREIGN KEY ("origin_reviewer_id") REFERENCES "public"."users"("id") ON DELETE set null ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "review_queue_items" ADD CONSTRAINT "review_queue_items_escalated_to_id_users_id_fk" FOREIGN KEY ("escalated_to_id") REFERENCES "public"."users"("id") ON DELETE set null ON UPDATE no action;--> statement-breakpoint
-- Полный (непартиальный) индекс с tenant_id первым — контрактный тест 2 пакета (`40` §8).
CREATE INDEX "idx_review_queue_items_tenant" ON "review_queue_items" USING btree ("tenant_id","status","sla_due_at");--> statement-breakpoint
CREATE INDEX "idx_review_queue_items_reviewer" ON "review_queue_items" USING btree ("tenant_id","assigned_reviewer_id","status") WHERE status <> 'done';--> statement-breakpoint
CREATE INDEX "idx_review_queue_items_origin" ON "review_queue_items" USING btree ("tenant_id","origin_reviewer_id") WHERE delegation_id is not null;--> statement-breakpoint
-- Одна единица работы — одна строка. Повторная сдача после доработки переиспользует ту же
-- workshop_submissions.id, поэтому enqueueReview() открывает ту же строку заново
-- (on conflict do update), а не вставляет вторую и не удаляет первую.
CREATE UNIQUE INDEX "uq_review_queue_items_source" ON "review_queue_items" USING btree ("tenant_id","task_type","source_id");--> statement-breakpoint
ALTER TABLE review_queue_items ENABLE ROW LEVEL SECURITY;--> statement-breakpoint
ALTER TABLE review_queue_items FORCE ROW LEVEL SECURITY;--> statement-breakpoint
CREATE POLICY tenant_isolation ON review_queue_items
  USING (tenant_id = nullif(current_setting('app.tenant_id', true), '')::uuid)
  WITH CHECK (tenant_id = nullif(current_setting('app.tenant_id', true), '')::uuid);--> statement-breakpoint

-- ── Бэкфилл (В-2: «из незакрытых сдач и непроверенных ответов») ─────────────────────────────
-- Единственное место, где очередь наполняется не сервисом: первичная загрузка уже накопленной
-- работы. Дальше пишет только enqueueReview(). Повторный прогон безопасен — on conflict.
--
-- 1. Практикумы: сдачи в состоянии submitted / in_review. Состояние захвата переносится
--    один в один, чтобы взятая наставником карточка не всплыла у другого.
INSERT INTO review_queue_items (
  tenant_id, task_type, source_id, user_id, subject_kind, task_title, track_id,
  location_id, position_id, submitted_at, attempt_no, status, priority,
  assigned_reviewer_id, assigned_at, sla_hours, sla_due_at
)
SELECT s.tenant_id, 'workshop', s.id, s.user_id, u.kind, w.title, e.subject_id,
       pl.location_id, pl.position_id, coalesce(s.submitted_at, s.created_at), s.attempt_no,
       CASE WHEN s.status = 'in_review' THEN 'in_review' ELSE 'waiting' END,
       CASE WHEN s.sla_due_at < now() THEN 10 ELSE 0 END,
       s.reviewer_id, s.claimed_at, w.sla_hours, s.sla_due_at
FROM workshop_submissions s
JOIN workshops w ON w.id = s.workshop_id
JOIN users u ON u.id = s.user_id
-- «Трек» — курс, внутри которого сдана работа; вне курса трека нет (null), и это не ошибка.
LEFT JOIN enrollments e ON e.id = s.enrollment_id AND e.subject_type = 'course'
LEFT JOIN LATERAL (
  SELECT p.location_id, p.position_id FROM user_placements p
  WHERE p.user_id = s.user_id AND p.is_primary AND p.ended_at IS NULL LIMIT 1
) pl ON true
WHERE s.status IN ('submitted', 'in_review')
ON CONFLICT (tenant_id, task_type, source_id) DO NOTHING;--> statement-breakpoint

-- 2. Развёрнутые ответы тестов: ручной ответ без решения в завершённой попытке. Ровно то же
--    условие, по которому очередь собиралась запросом (attempts.ts, listReviewAnswers).
INSERT INTO review_queue_items (
  tenant_id, task_type, source_id, user_id, subject_kind, task_title, track_id,
  location_id, position_id, submitted_at, attempt_no, status, sla_hours, sla_due_at
)
SELECT aa.tenant_id, 'quiz_open_answer', aa.id, a.user_id, u.kind, q.title, e.subject_id,
       pl.location_id, pl.position_id, coalesce(a.submitted_at, aa.created_at), a.attempt_no,
       'waiting', 48, coalesce(a.submitted_at, aa.created_at) + interval '48 hours'
FROM attempt_answers aa
JOIN attempts a ON a.id = aa.attempt_id
JOIN quizzes q ON q.id = a.quiz_id
JOIN users u ON u.id = a.user_id
LEFT JOIN enrollments e ON e.id = a.enrollment_id AND e.subject_type = 'course'
LEFT JOIN LATERAL (
  SELECT p.location_id, p.position_id FROM user_placements p
  WHERE p.user_id = a.user_id AND p.is_primary AND p.ended_at IS NULL LIMIT 1
) pl ON true
WHERE aa.auto_graded = false AND aa.is_correct IS NULL
  AND a.status IN ('review', 'passed', 'failed', 'expired')
ON CONFLICT (tenant_id, task_type, source_id) DO NOTHING;
