CREATE TABLE "attempt_answers" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	"updated_at" timestamp with time zone DEFAULT now() NOT NULL,
	"tenant_id" uuid NOT NULL,
	"attempt_id" uuid NOT NULL,
	"question_id" uuid NOT NULL,
	"question_version" integer NOT NULL,
	"answer" jsonb,
	"is_correct" boolean,
	"score" numeric(5, 2),
	"auto_graded" boolean DEFAULT false NOT NULL,
	"reviewed_by" uuid,
	"reviewed_at" timestamp with time zone,
	"review_comment" text,
	"answered_at" timestamp with time zone,
	CONSTRAINT "attempt_answers_tenant_id_attempt_id_question_id_unique" UNIQUE("tenant_id","attempt_id","question_id")
);
--> statement-breakpoint
CREATE TABLE "attempts" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	"updated_at" timestamp with time zone DEFAULT now() NOT NULL,
	"tenant_id" uuid NOT NULL,
	"quiz_id" uuid NOT NULL,
	"enrollment_id" uuid,
	"lesson_id" uuid,
	"user_id" uuid NOT NULL,
	"attempt_no" integer NOT NULL,
	"snapshot" jsonb NOT NULL,
	"params" jsonb NOT NULL,
	"status" text DEFAULT 'in_progress' NOT NULL,
	"score" numeric(5, 2),
	"max_score" numeric(7, 2),
	"passed" boolean,
	"started_at" timestamp with time zone DEFAULT now() NOT NULL,
	"deadline_at" timestamp with time zone,
	"submitted_at" timestamp with time zone,
	"graded_at" timestamp with time zone,
	"time_spent_sec" integer DEFAULT 0 NOT NULL,
	"ip" "inet",
	"device" text,
	"annulled_by" uuid,
	"annul_reason" text
);
--> statement-breakpoint
CREATE TABLE "certificate_counters" (
	"tenant_id" uuid NOT NULL,
	"year" integer NOT NULL,
	"last" integer DEFAULT 0 NOT NULL,
	CONSTRAINT "certificate_counters_tenant_id_year_unique" UNIQUE("tenant_id","year")
);
--> statement-breakpoint
CREATE TABLE "certificates" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	"updated_at" timestamp with time zone DEFAULT now() NOT NULL,
	"tenant_id" uuid NOT NULL,
	"user_id" uuid NOT NULL,
	"course_id" uuid,
	"enrollment_id" uuid,
	"attempt_id" uuid,
	"number" text NOT NULL,
	"score" numeric(5, 2),
	"issued_at" timestamp with time zone DEFAULT now() NOT NULL,
	"valid_until" timestamp with time zone,
	"pdf_key" text,
	"public_token" text NOT NULL,
	"revoked_at" timestamp with time zone,
	"revoked_by" uuid,
	"revoke_reason" text,
	CONSTRAINT "certificates_public_token_unique" UNIQUE("public_token"),
	CONSTRAINT "certificates_tenant_id_number_unique" UNIQUE("tenant_id","number"),
	CONSTRAINT "certificates_tenant_id_enrollment_id_attempt_id_unique" UNIQUE("tenant_id","enrollment_id","attempt_id")
);
--> statement-breakpoint
CREATE TABLE "question_banks" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	"updated_at" timestamp with time zone DEFAULT now() NOT NULL,
	"tenant_id" uuid NOT NULL,
	"name" text NOT NULL,
	"category_id" uuid,
	"description" text,
	"is_shared" boolean DEFAULT true NOT NULL
);
--> statement-breakpoint
CREATE TABLE "questions" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	"updated_at" timestamp with time zone DEFAULT now() NOT NULL,
	"tenant_id" uuid NOT NULL,
	"bank_id" uuid NOT NULL,
	"kind" text DEFAULT 'single' NOT NULL,
	"stem" jsonb NOT NULL,
	"options" jsonb,
	"answer" jsonb,
	"explanation" jsonb,
	"hint" text,
	"is_critical" boolean DEFAULT false NOT NULL,
	"difficulty" integer DEFAULT 3 NOT NULL,
	"points" numeric(5, 2) DEFAULT '1' NOT NULL,
	"partial_credit" boolean DEFAULT true NOT NULL,
	"negative_marking" boolean DEFAULT false NOT NULL,
	"tags" text[] DEFAULT '{}'::text[] NOT NULL,
	"time_limit_sec" integer,
	"status" text DEFAULT 'active' NOT NULL,
	"version" integer DEFAULT 1 NOT NULL,
	"stats" jsonb DEFAULT '{}' NOT NULL
);
--> statement-breakpoint
CREATE TABLE "quiz_questions" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	"updated_at" timestamp with time zone DEFAULT now() NOT NULL,
	"tenant_id" uuid NOT NULL,
	"quiz_id" uuid NOT NULL,
	"question_id" uuid NOT NULL,
	"sort" integer NOT NULL,
	"points_override" numeric(5, 2),
	"is_critical_override" boolean,
	CONSTRAINT "quiz_questions_tenant_id_quiz_id_question_id_unique" UNIQUE("tenant_id","quiz_id","question_id")
);
--> statement-breakpoint
CREATE TABLE "quizzes" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	"updated_at" timestamp with time zone DEFAULT now() NOT NULL,
	"tenant_id" uuid NOT NULL,
	"title" text NOT NULL,
	"description" jsonb,
	"cover_key" text,
	"kind" text DEFAULT 'quiz' NOT NULL,
	"tags" text[] DEFAULT '{}'::text[] NOT NULL,
	"author_ids" uuid[] DEFAULT '{}'::uuid[] NOT NULL,
	"selection_mode" text DEFAULT 'fixed' NOT NULL,
	"random_rules" jsonb,
	"params" jsonb DEFAULT '{}'::jsonb NOT NULL,
	"requires_offline_confirm" boolean DEFAULT false NOT NULL,
	"status" text DEFAULT 'draft' NOT NULL,
	"total_points" numeric(7, 2) DEFAULT '0' NOT NULL,
	"question_count" integer DEFAULT 0 NOT NULL,
	"deleted_at" timestamp with time zone
);
--> statement-breakpoint
ALTER TABLE "attempt_answers" ADD CONSTRAINT "attempt_answers_attempt_id_attempts_id_fk" FOREIGN KEY ("attempt_id") REFERENCES "public"."attempts"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "attempt_answers" ADD CONSTRAINT "attempt_answers_reviewed_by_users_id_fk" FOREIGN KEY ("reviewed_by") REFERENCES "public"."users"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "attempts" ADD CONSTRAINT "attempts_quiz_id_quizzes_id_fk" FOREIGN KEY ("quiz_id") REFERENCES "public"."quizzes"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "attempts" ADD CONSTRAINT "attempts_enrollment_id_enrollments_id_fk" FOREIGN KEY ("enrollment_id") REFERENCES "public"."enrollments"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "attempts" ADD CONSTRAINT "attempts_user_id_users_id_fk" FOREIGN KEY ("user_id") REFERENCES "public"."users"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "attempts" ADD CONSTRAINT "attempts_annulled_by_users_id_fk" FOREIGN KEY ("annulled_by") REFERENCES "public"."users"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "certificates" ADD CONSTRAINT "certificates_user_id_users_id_fk" FOREIGN KEY ("user_id") REFERENCES "public"."users"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "certificates" ADD CONSTRAINT "certificates_course_id_courses_id_fk" FOREIGN KEY ("course_id") REFERENCES "public"."courses"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "certificates" ADD CONSTRAINT "certificates_enrollment_id_enrollments_id_fk" FOREIGN KEY ("enrollment_id") REFERENCES "public"."enrollments"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "certificates" ADD CONSTRAINT "certificates_attempt_id_attempts_id_fk" FOREIGN KEY ("attempt_id") REFERENCES "public"."attempts"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "certificates" ADD CONSTRAINT "certificates_revoked_by_users_id_fk" FOREIGN KEY ("revoked_by") REFERENCES "public"."users"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "question_banks" ADD CONSTRAINT "question_banks_category_id_course_categories_id_fk" FOREIGN KEY ("category_id") REFERENCES "public"."course_categories"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "questions" ADD CONSTRAINT "questions_bank_id_question_banks_id_fk" FOREIGN KEY ("bank_id") REFERENCES "public"."question_banks"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "quiz_questions" ADD CONSTRAINT "quiz_questions_quiz_id_quizzes_id_fk" FOREIGN KEY ("quiz_id") REFERENCES "public"."quizzes"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "quiz_questions" ADD CONSTRAINT "quiz_questions_question_id_questions_id_fk" FOREIGN KEY ("question_id") REFERENCES "public"."questions"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
CREATE INDEX "attempts_tenant_id_user_id_quiz_id_attempt_no_index" ON "attempts" USING btree ("tenant_id","user_id","quiz_id","attempt_no");--> statement-breakpoint
CREATE INDEX "attempts_tenant_id_status_index" ON "attempts" USING btree ("tenant_id","status");--> statement-breakpoint
CREATE INDEX "certificates_tenant_id_user_id_issued_at_index" ON "certificates" USING btree ("tenant_id","user_id","issued_at" DESC NULLS LAST);--> statement-breakpoint
CREATE INDEX "questions_tenant_id_bank_id_status_index" ON "questions" USING btree ("tenant_id","bank_id","status");--> statement-breakpoint
-- RLS для новых таблиц (правило CLAUDE.md №4)
DO $$
DECLARE t text;
BEGIN
  FOREACH t IN ARRAY ARRAY[
    'question_banks', 'questions', 'quizzes', 'quiz_questions', 'attempts',
    'attempt_answers', 'certificates', 'certificate_counters'
  ]
  LOOP
    EXECUTE format('ALTER TABLE %I ENABLE ROW LEVEL SECURITY', t);
    EXECUTE format('ALTER TABLE %I FORCE ROW LEVEL SECURITY', t);
    EXECUTE format($p$
      CREATE POLICY tenant_isolation ON %I
        USING (tenant_id = nullif(current_setting('app.tenant_id', true), '')::uuid)
        WITH CHECK (tenant_id = nullif(current_setting('app.tenant_id', true), '')::uuid)
    $p$, t);
  END LOOP;
END $$;
--> statement-breakpoint
-- Публичная проверка сертификата без входа (docs/14 §5.5): SECURITY DEFINER, отдаёт только безопасные поля
CREATE OR REPLACE FUNCTION public_certificate(p_token text)
RETURNS TABLE (
  number text, full_name text, course_title text, tenant_name text,
  issued_at timestamptz, valid_until timestamptz, revoked_at timestamptz, score numeric
)
LANGUAGE sql SECURITY DEFINER STABLE
SET search_path = public
AS $$
  SELECT c.number, u.full_name, co.title, t.name, c.issued_at, c.valid_until, c.revoked_at, c.score
  FROM certificates c
  JOIN users u ON u.id = c.user_id
  JOIN tenants t ON t.id = c.tenant_id
  LEFT JOIN courses co ON co.id = c.course_id
  WHERE c.public_token = p_token;
$$;
--> statement-breakpoint
REVOKE ALL ON FUNCTION public_certificate(text) FROM public;--> statement-breakpoint
GRANT EXECUTE ON FUNCTION public_certificate(text) TO app_user;
