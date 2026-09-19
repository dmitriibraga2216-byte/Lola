CREATE TABLE "attempt_requests" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	"updated_at" timestamp with time zone DEFAULT now() NOT NULL,
	"tenant_id" uuid NOT NULL,
	"quiz_id" uuid NOT NULL,
	"user_id" uuid NOT NULL,
	"enrollment_id" uuid,
	"assignment_id" uuid,
	"reason" text NOT NULL,
	"attempts_used" integer NOT NULL,
	"attempts_allowed" integer NOT NULL,
	"status" text DEFAULT 'pending' NOT NULL,
	"decided_by" uuid,
	"decided_at" timestamp with time zone,
	"decision_comment" text,
	"request_context" jsonb
);
--> statement-breakpoint
CREATE TABLE "attempt_results" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	"updated_at" timestamp with time zone DEFAULT now() NOT NULL,
	"tenant_id" uuid NOT NULL,
	"attempt_id" uuid NOT NULL,
	"reason" text NOT NULL,
	"status" text NOT NULL,
	"score" numeric(5, 2),
	"max_score" numeric(7, 2),
	"passed" boolean,
	"created_by" uuid,
	"comment" text
);
--> statement-breakpoint
CREATE TABLE "question_groups" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	"updated_at" timestamp with time zone DEFAULT now() NOT NULL,
	"tenant_id" uuid NOT NULL,
	"quiz_id" uuid NOT NULL,
	"title" text NOT NULL,
	"sort_order" integer DEFAULT 0 NOT NULL
);
--> statement-breakpoint
ALTER TABLE "questions" ADD COLUMN "question_group_id" uuid;--> statement-breakpoint
ALTER TABLE "questions" ADD COLUMN "grader_hint" text;--> statement-breakpoint
ALTER TABLE "questions" ADD COLUMN "attach_files" boolean DEFAULT false NOT NULL;--> statement-breakpoint
ALTER TABLE "questions" ADD COLUMN "scoring_method" text DEFAULT 'formula' NOT NULL;--> statement-breakpoint
ALTER TABLE "attempt_requests" ADD CONSTRAINT "attempt_requests_quiz_id_quizzes_id_fk" FOREIGN KEY ("quiz_id") REFERENCES "public"."quizzes"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "attempt_requests" ADD CONSTRAINT "attempt_requests_user_id_users_id_fk" FOREIGN KEY ("user_id") REFERENCES "public"."users"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "attempt_requests" ADD CONSTRAINT "attempt_requests_enrollment_id_enrollments_id_fk" FOREIGN KEY ("enrollment_id") REFERENCES "public"."enrollments"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "attempt_requests" ADD CONSTRAINT "attempt_requests_decided_by_users_id_fk" FOREIGN KEY ("decided_by") REFERENCES "public"."users"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "attempt_results" ADD CONSTRAINT "attempt_results_attempt_id_attempts_id_fk" FOREIGN KEY ("attempt_id") REFERENCES "public"."attempts"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "attempt_results" ADD CONSTRAINT "attempt_results_created_by_users_id_fk" FOREIGN KEY ("created_by") REFERENCES "public"."users"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "question_groups" ADD CONSTRAINT "question_groups_quiz_id_quizzes_id_fk" FOREIGN KEY ("quiz_id") REFERENCES "public"."quizzes"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
CREATE INDEX "attempt_requests_tenant_id_status_created_at_index" ON "attempt_requests" USING btree ("tenant_id","status","created_at");--> statement-breakpoint
CREATE INDEX "attempt_requests_tenant_id_user_id_quiz_id_index" ON "attempt_requests" USING btree ("tenant_id","user_id","quiz_id");--> statement-breakpoint
CREATE INDEX "attempt_results_tenant_id_attempt_id_index" ON "attempt_results" USING btree ("tenant_id","attempt_id");--> statement-breakpoint
CREATE INDEX "question_groups_tenant_id_quiz_id_index" ON "question_groups" USING btree ("tenant_id","quiz_id");--> statement-breakpoint
ALTER TABLE "questions" ADD CONSTRAINT "questions_question_group_id_question_groups_id_fk" FOREIGN KEY ("question_group_id") REFERENCES "public"."question_groups"("id") ON DELETE set null ON UPDATE no action;--> statement-breakpoint
-- «Метод підрахунку балів» (docs/12 §14.6) заменяет булев partial_credit: значение переносится, колонка уходит
UPDATE "questions" SET "scoring_method" = CASE WHEN "partial_credit" THEN 'formula' ELSE 'all_or_nothing' END;--> statement-breakpoint
ALTER TABLE "questions" DROP COLUMN "partial_credit";--> statement-breakpoint
ALTER TABLE "questions" ADD CONSTRAINT "questions_scoring_method_check" CHECK ("scoring_method" IN ('formula', 'all_or_nothing'));--> statement-breakpoint
-- Коды типов вопросов — из docs/02 (эталон), см. docs/30 §3 п. 3: старые коды Lola переименовываются.
-- Снимки попыток трогаются только в поле kind — это техническое переименование кода, не правка содержания.
UPDATE "questions" SET "kind" = CASE "kind"
  WHEN 'multiple' THEN 'multi' WHEN 'order' THEN 'ordering' WHEN 'match' THEN 'comparison' WHEN 'text_long' THEN 'free' ELSE "kind" END
  WHERE "kind" IN ('multiple', 'order', 'match', 'text_long');--> statement-breakpoint
UPDATE "attempts" SET "snapshot" = (
  SELECT jsonb_agg(
    CASE WHEN e->>'kind' IN ('multiple', 'order', 'match', 'text_long')
      THEN jsonb_set(e, '{kind}', to_jsonb(CASE e->>'kind' WHEN 'multiple' THEN 'multi' WHEN 'order' THEN 'ordering' WHEN 'match' THEN 'comparison' ELSE 'free' END))
      ELSE e END ORDER BY ord)
  FROM jsonb_array_elements("snapshot") WITH ORDINALITY AS t(e, ord))
  WHERE jsonb_typeof("snapshot") = 'array'
    AND EXISTS (SELECT 1 FROM jsonb_array_elements("snapshot") e WHERE e->>'kind' IN ('multiple', 'order', 'match', 'text_long'));--> statement-breakpoint
ALTER TABLE "questions" ADD CONSTRAINT "questions_kind_check" CHECK ("kind" IN ('single', 'multi', 'free', 'ordering', 'classification', 'comparison', 'answer_by_map', 'number', 'text_short', 'file'));--> statement-breakpoint
-- Статус запроса попытки и причина записи результата — значения по docs/02 (перечисления)
ALTER TABLE "attempt_requests" ADD CONSTRAINT "attempt_requests_status_check" CHECK ("status" IN ('pending', 'approved', 'rejected'));--> statement-breakpoint
ALTER TABLE "attempt_results" ADD CONSTRAINT "attempt_results_reason_check" CHECK ("reason" IN ('submit', 'review', 'recalculate'));--> statement-breakpoint
-- Таблицы тенанта — RLS обязателен (CLAUDE.md п. 1)
ALTER TABLE question_groups ENABLE ROW LEVEL SECURITY;--> statement-breakpoint
ALTER TABLE question_groups FORCE ROW LEVEL SECURITY;--> statement-breakpoint
CREATE POLICY tenant_isolation ON question_groups
  USING (tenant_id = nullif(current_setting('app.tenant_id', true), '')::uuid)
  WITH CHECK (tenant_id = nullif(current_setting('app.tenant_id', true), '')::uuid);--> statement-breakpoint
ALTER TABLE attempt_requests ENABLE ROW LEVEL SECURITY;--> statement-breakpoint
ALTER TABLE attempt_requests FORCE ROW LEVEL SECURITY;--> statement-breakpoint
CREATE POLICY tenant_isolation ON attempt_requests
  USING (tenant_id = nullif(current_setting('app.tenant_id', true), '')::uuid)
  WITH CHECK (tenant_id = nullif(current_setting('app.tenant_id', true), '')::uuid);--> statement-breakpoint
ALTER TABLE attempt_results ENABLE ROW LEVEL SECURITY;--> statement-breakpoint
ALTER TABLE attempt_results FORCE ROW LEVEL SECURITY;--> statement-breakpoint
CREATE POLICY tenant_isolation ON attempt_results
  USING (tenant_id = nullif(current_setting('app.tenant_id', true), '')::uuid)
  WITH CHECK (tenant_id = nullif(current_setting('app.tenant_id', true), '')::uuid);