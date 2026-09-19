-- Правила прохождения живут только в назначении (CLAUDE.md п. 11, docs/15 §14.3, docs/02 «Что проверяет тест схемы»).
-- 1. Новые колонки
ALTER TABLE "lessons" ADD COLUMN "pass_score_pct" numeric(5, 2);--> statement-breakpoint
ALTER TABLE "attempts" ADD COLUMN "assignment_id" uuid;--> statement-breakpoint
ALTER TABLE "complex_test_attempts" ADD COLUMN "assignment_id" uuid;--> statement-breakpoint
ALTER TABLE "complex_test_attempts" ADD COLUMN "params" jsonb DEFAULT '{}'::jsonb NOT NULL;--> statement-breakpoint

-- 2. Индекс, начинающийся с tenant_id, у каждой таблицы с tenant_id (docs/25 §15, docs/02 «Что проверяет тест схемы» п. 1)
CREATE INDEX "invitations_tenant_id_index" ON "invitations" USING btree ("tenant_id");--> statement-breakpoint
CREATE INDEX "otp_codes_tenant_id_index" ON "otp_codes" USING btree ("tenant_id");--> statement-breakpoint
CREATE INDEX "sessions_tenant_id_index" ON "sessions" USING btree ("tenant_id");--> statement-breakpoint
CREATE INDEX "import_jobs_tenant_id_index" ON "import_jobs" USING btree ("tenant_id");--> statement-breakpoint
CREATE INDEX "course_categories_tenant_id_index" ON "course_categories" USING btree ("tenant_id");--> statement-breakpoint
CREATE INDEX "modules_tenant_id_index" ON "modules" USING btree ("tenant_id");--> statement-breakpoint
CREATE INDEX "enrollment_events_tenant_id_index" ON "enrollment_events" USING btree ("tenant_id");--> statement-breakpoint
CREATE INDEX "question_banks_tenant_id_index" ON "question_banks" USING btree ("tenant_id");--> statement-breakpoint
CREATE INDEX "quizzes_tenant_id_index" ON "quizzes" USING btree ("tenant_id");--> statement-breakpoint
CREATE INDEX "automation_rules_tenant_id_index" ON "automation_rules" USING btree ("tenant_id");--> statement-breakpoint
CREATE INDEX "learning_profiles_tenant_id_index" ON "learning_profiles" USING btree ("tenant_id");--> statement-breakpoint
CREATE INDEX "notification_template_versions_tenant_id_index" ON "notification_template_versions" USING btree ("tenant_id");--> statement-breakpoint
CREATE INDEX "telegram_tokens_tenant_id_index" ON "telegram_tokens" USING btree ("tenant_id");--> statement-breakpoint
CREATE INDEX "knowledge_revisions_tenant_id_index" ON "knowledge_revisions" USING btree ("tenant_id");--> statement-breakpoint
CREATE INDEX "surveys_tenant_id_index" ON "surveys" USING btree ("tenant_id");--> statement-breakpoint
CREATE INDEX "workshop_comments_tenant_id_index" ON "workshop_comments" USING btree ("tenant_id");--> statement-breakpoint
CREATE INDEX "workshops_tenant_id_index" ON "workshops" USING btree ("tenant_id");--> statement-breakpoint
CREATE INDEX "api_tokens_tenant_id_index" ON "api_tokens" USING btree ("tenant_id");--> statement-breakpoint
CREATE INDEX "oauth_states_tenant_id_index" ON "oauth_states" USING btree ("tenant_id");--> statement-breakpoint
CREATE INDEX "webhook_endpoints_tenant_id_index" ON "webhook_endpoints" USING btree ("tenant_id");--> statement-breakpoint
CREATE INDEX "career_requests_tenant_id_index" ON "career_requests" USING btree ("tenant_id");--> statement-breakpoint
CREATE INDEX "goal_comments_tenant_id_index" ON "goal_comments" USING btree ("tenant_id");--> statement-breakpoint
CREATE INDEX "goal_status_log_tenant_id_index" ON "goal_status_log" USING btree ("tenant_id");--> statement-breakpoint
CREATE INDEX "assessment_answers_tenant_id_index" ON "assessment_answers" USING btree ("tenant_id");--> statement-breakpoint
CREATE INDEX "assessment_forms_tenant_id_index" ON "assessment_forms" USING btree ("tenant_id");--> statement-breakpoint
CREATE INDEX "checklists_tenant_id_index" ON "checklists" USING btree ("tenant_id");--> statement-breakpoint
CREATE INDEX "criteria_groups_tenant_id_index" ON "criteria_groups" USING btree ("tenant_id");--> statement-breakpoint
CREATE INDEX "mystery_links_tenant_id_index" ON "mystery_links" USING btree ("tenant_id");--> statement-breakpoint
CREATE INDEX "complex_tests_tenant_id_index" ON "complex_tests" USING btree ("tenant_id");--> statement-breakpoint
CREATE INDEX "webinar_participations_tenant_id_index" ON "webinar_participations" USING btree ("tenant_id");--> statement-breakpoint
CREATE INDEX "webinars_tenant_id_index" ON "webinars" USING btree ("tenant_id");--> statement-breakpoint
CREATE INDEX "saved_reports_tenant_id_index" ON "saved_reports" USING btree ("tenant_id");--> statement-breakpoint
CREATE INDEX "wiki_revisions_tenant_id_index" ON "wiki_revisions" USING btree ("tenant_id");--> statement-breakpoint
CREATE INDEX "program_edges_tenant_id_index" ON "program_edges" USING btree ("tenant_id");--> statement-breakpoint
CREATE INDEX "functional_chiefs_tenant_id_index" ON "functional_chiefs" USING btree ("tenant_id");--> statement-breakpoint
CREATE INDEX "user_notes_tenant_id_index" ON "user_notes" USING btree ("tenant_id");--> statement-breakpoint

-- 3. Перечисления из docs/02: content_type и task_type
UPDATE "assignments" SET "subject_type" = 'test' WHERE "subject_type" = 'quiz';--> statement-breakpoint
UPDATE "assignments" SET "subject_type" = 'training_program' WHERE "subject_type" = 'program';--> statement-breakpoint
UPDATE "assignments" SET "kind" = 'auto' WHERE "kind" = 'profile';--> statement-breakpoint
UPDATE "learning_profiles" SET "items" = (
  SELECT coalesce(jsonb_agg(CASE WHEN it->>'subjectType' = 'quiz' THEN it || '{"subjectType":"test"}'::jsonb ELSE it END ORDER BY ord), '[]'::jsonb)
  FROM jsonb_array_elements("items") WITH ORDINALITY AS x(it, ord)
) WHERE "items"::text LIKE '%"quiz"%';--> statement-breakpoint
UPDATE "automation_rules" SET "actions" = (
  SELECT coalesce(jsonb_agg(CASE WHEN it->>'subjectType' = 'quiz' THEN it || '{"subjectType":"test"}'::jsonb ELSE it END ORDER BY ord), '[]'::jsonb)
  FROM jsonb_array_elements("actions") WITH ORDINALITY AS x(it, ord)
) WHERE "actions"::text LIKE '%"quiz"%';--> statement-breakpoint

-- 4. Перенос правил из контента в назначения (данные dev/demo; на проде назначений с правилами в тесте не было)
-- 4a. Порог теста в плане курса
UPDATE "lessons" l SET "pass_score_pct" = (q."params"->>'passScore')::numeric
FROM "quizzes" q
WHERE l."item_type" = 'quiz' AND l."item_id" = q."id" AND q."params" ? 'passScore';--> statement-breakpoint
-- 4b. Назначения теста: правила теста под правилами назначения
UPDATE "assignments" a SET "params" = coalesce(q."params", '{}'::jsonb) || a."params"
FROM "quizzes" q
WHERE a."subject_type" = 'test' AND a."subject_id" = q."id";--> statement-breakpoint
-- 4c. Назначения курса: правила первого теста в курсе (без порога — он в плане) под правилами назначения
UPDATE "assignments" a SET "params" = (coalesce(x."params", '{}'::jsonb) - 'passScore') || a."params"
FROM (
  SELECT DISTINCT ON (c."id") c."id" AS course_id, q."params"
  FROM "courses" c
  JOIN "modules" m ON m."course_version_id" = c."published_version_id"
  JOIN "lessons" l ON l."module_id" = m."id" AND l."item_type" = 'quiz'
  JOIN "quizzes" q ON q."id" = l."item_id"
  ORDER BY c."id", m."sort", l."sort"
) x
WHERE a."subject_type" = 'course' AND a."subject_id" = x.course_id;--> statement-breakpoint
-- 4d. Комплексные тесты: правила уезжают в каталожное назначение на всех активных
INSERT INTO "assignments" ("tenant_id", "title", "kind", "subject_type", "subject_id", "audience", "exclude", "due_mode", "due_days", "is_mandatory", "params", "reminders", "auto_sync", "status", "created_by")
SELECT ct."tenant_id", ct."title", 'catalog', 'complex_test', ct."id",
  '{"rules":[{"type":"segment","filter":{}}],"match":"any"}'::jsonb, '{"rules":[]}'::jsonb, 'none', NULL, false,
  jsonb_strip_nulls(jsonb_build_object('passScore', ct."pass_score", 'timeLimitSec', ct."time_limit_sec", 'attemptsAllowed', ct."attempts_allowed")),
  '{"enabled":false}'::jsonb, false, 'active', ct."created_by"
FROM "complex_tests" ct
WHERE NOT EXISTS (SELECT 1 FROM "assignments" a WHERE a."subject_type" = 'complex_test' AND a."subject_id" = ct."id");--> statement-breakpoint
UPDATE "complex_test_attempts" ca SET "params" = jsonb_strip_nulls(jsonb_build_object('passScore', ct."pass_score", 'timeLimitSec', ct."time_limit_sec", 'attemptsAllowed', ct."attempts_allowed"))
FROM "complex_tests" ct WHERE ca."complex_test_id" = ct."id";--> statement-breakpoint
UPDATE "attempts" at SET "assignment_id" = e."assignment_id"
FROM "enrollments" e WHERE at."enrollment_id" = e."id" AND e."assignment_id" IS NOT NULL;--> statement-breakpoint

-- 5. Из контента правила удаляются
ALTER TABLE "quizzes" DROP COLUMN "params";--> statement-breakpoint
ALTER TABLE "complex_tests" DROP COLUMN "pass_score";--> statement-breakpoint
ALTER TABLE "complex_tests" DROP COLUMN "time_limit_sec";--> statement-breakpoint
ALTER TABLE "complex_tests" DROP COLUMN "attempts_allowed";--> statement-breakpoint

-- 6. Перечисления docs/02 закреплены ограничениями (tests/integration/schema-parity.spec.ts)
ALTER TABLE "assignments" ADD CONSTRAINT "assignments_subject_type_content_type" CHECK ("subject_type" IN ('course', 'training_program', 'resource', 'test', 'complex_test', 'workshop', 'poll', 'assessment', 'check_list', 'meetup', 'webinar'));--> statement-breakpoint
ALTER TABLE "assignments" ADD CONSTRAINT "assignments_kind_task_type" CHECK ("kind" IN ('manual', 'auto', 'catalog', 'trajectory', 'archive'));
