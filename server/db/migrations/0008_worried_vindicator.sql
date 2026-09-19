CREATE TABLE "knowledge_articles" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	"updated_at" timestamp with time zone DEFAULT now() NOT NULL,
	"tenant_id" uuid NOT NULL,
	"title" text NOT NULL,
	"slug" text NOT NULL,
	"summary" text,
	"body" jsonb DEFAULT '[]' NOT NULL,
	"plain_text" text DEFAULT '' NOT NULL,
	"category_id" uuid,
	"tags" text[] DEFAULT '{}'::text[] NOT NULL,
	"status" text DEFAULT 'draft' NOT NULL,
	"visibility" jsonb DEFAULT '{"scope":"tenant"}'::jsonb NOT NULL,
	"search_tsv" "tsvector",
	"embedding" vector(1536),
	"version" integer DEFAULT 1 NOT NULL,
	"updated_by" uuid,
	"view_count" integer DEFAULT 0 NOT NULL,
	"deleted_at" timestamp with time zone,
	CONSTRAINT "knowledge_articles_tenant_id_slug_unique" UNIQUE("tenant_id","slug")
);
--> statement-breakpoint
CREATE TABLE "knowledge_links" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	"updated_at" timestamp with time zone DEFAULT now() NOT NULL,
	"tenant_id" uuid NOT NULL,
	"article_id" uuid NOT NULL,
	"target_type" text NOT NULL,
	"target_id" uuid NOT NULL,
	CONSTRAINT "knowledge_links_tenant_id_article_id_target_type_target_id_unique" UNIQUE("tenant_id","article_id","target_type","target_id")
);
--> statement-breakpoint
CREATE TABLE "knowledge_revisions" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	"updated_at" timestamp with time zone DEFAULT now() NOT NULL,
	"tenant_id" uuid NOT NULL,
	"article_id" uuid NOT NULL,
	"version" integer NOT NULL,
	"title" text NOT NULL,
	"body" jsonb NOT NULL,
	"author_id" uuid,
	"comment" text
);
--> statement-breakpoint
CREATE TABLE "news" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	"updated_at" timestamp with time zone DEFAULT now() NOT NULL,
	"tenant_id" uuid NOT NULL,
	"title" text NOT NULL,
	"body" jsonb DEFAULT '[]' NOT NULL,
	"cover_key" text,
	"category_id" uuid,
	"is_pinned" boolean DEFAULT false NOT NULL,
	"requires_ack" boolean DEFAULT false NOT NULL,
	"audience" jsonb,
	"status" text DEFAULT 'draft' NOT NULL,
	"published_at" timestamp with time zone,
	"author_id" uuid,
	"deleted_at" timestamp with time zone
);
--> statement-breakpoint
CREATE TABLE "news_views" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	"updated_at" timestamp with time zone DEFAULT now() NOT NULL,
	"tenant_id" uuid NOT NULL,
	"news_id" uuid NOT NULL,
	"user_id" uuid NOT NULL,
	"viewed_at" timestamp with time zone DEFAULT now() NOT NULL,
	"acked_at" timestamp with time zone,
	CONSTRAINT "news_views_tenant_id_news_id_user_id_unique" UNIQUE("tenant_id","news_id","user_id")
);
--> statement-breakpoint
CREATE TABLE "survey_responses" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	"updated_at" timestamp with time zone DEFAULT now() NOT NULL,
	"tenant_id" uuid NOT NULL,
	"survey_id" uuid NOT NULL,
	"user_id" uuid,
	"respondent_hash" text,
	"enrollment_id" uuid,
	"answers" jsonb NOT NULL,
	"submitted_at" timestamp with time zone DEFAULT now() NOT NULL,
	CONSTRAINT "survey_responses_tenant_id_survey_id_respondent_hash_unique" UNIQUE("tenant_id","survey_id","respondent_hash")
);
--> statement-breakpoint
CREATE TABLE "surveys" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	"updated_at" timestamp with time zone DEFAULT now() NOT NULL,
	"tenant_id" uuid NOT NULL,
	"title" text NOT NULL,
	"description" text,
	"kind" text DEFAULT 'survey' NOT NULL,
	"questions" jsonb NOT NULL,
	"is_anonymous" boolean DEFAULT false NOT NULL,
	"status" text DEFAULT 'draft' NOT NULL,
	"opens_at" timestamp with time zone,
	"closes_at" timestamp with time zone,
	"trigger_course_id" uuid,
	"created_by" uuid
);
--> statement-breakpoint
CREATE TABLE "workshop_comments" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	"updated_at" timestamp with time zone DEFAULT now() NOT NULL,
	"tenant_id" uuid NOT NULL,
	"submission_id" uuid NOT NULL,
	"author_id" uuid NOT NULL,
	"body" text NOT NULL,
	"is_internal" boolean DEFAULT false NOT NULL,
	"deleted_at" timestamp with time zone
);
--> statement-breakpoint
CREATE TABLE "workshop_submissions" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	"updated_at" timestamp with time zone DEFAULT now() NOT NULL,
	"tenant_id" uuid NOT NULL,
	"workshop_id" uuid NOT NULL,
	"user_id" uuid NOT NULL,
	"enrollment_id" uuid,
	"lesson_id" uuid,
	"attempt_no" integer DEFAULT 1 NOT NULL,
	"body" jsonb DEFAULT '{}' NOT NULL,
	"files" jsonb DEFAULT '[]' NOT NULL,
	"criteria_snapshot" jsonb NOT NULL,
	"status" text DEFAULT 'draft' NOT NULL,
	"submitted_at" timestamp with time zone,
	"reviewer_id" uuid,
	"claimed_at" timestamp with time zone,
	"reviewed_at" timestamp with time zone,
	"criteria_results" jsonb,
	"score" numeric(5, 2),
	"passed" boolean,
	"review_comment" text,
	"rework_count" integer DEFAULT 0 NOT NULL,
	"sla_due_at" timestamp with time zone,
	"device" text
);
--> statement-breakpoint
CREATE TABLE "workshops" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	"updated_at" timestamp with time zone DEFAULT now() NOT NULL,
	"tenant_id" uuid NOT NULL,
	"title" text NOT NULL,
	"description" jsonb NOT NULL,
	"instruction_media" uuid[] DEFAULT '{}'::uuid[] NOT NULL,
	"submission_kinds" text[] DEFAULT '{text,photo}'::text[] NOT NULL,
	"min_text_length" integer,
	"max_files" integer DEFAULT 3 NOT NULL,
	"max_file_mb" integer DEFAULT 50 NOT NULL,
	"allow_camera_only" boolean DEFAULT false NOT NULL,
	"criteria" jsonb NOT NULL,
	"pass_rule" jsonb DEFAULT '{"type":"all_criteria"}'::jsonb NOT NULL,
	"reviewer_rule" text DEFAULT 'location_mentor' NOT NULL,
	"reviewer_ids" uuid[] DEFAULT '{}'::uuid[] NOT NULL,
	"allow_rework" boolean DEFAULT true NOT NULL,
	"max_reworks" integer DEFAULT 2 NOT NULL,
	"sla_hours" integer DEFAULT 48 NOT NULL,
	"status" text DEFAULT 'draft' NOT NULL,
	"author_ids" uuid[] DEFAULT '{}'::uuid[] NOT NULL,
	"deleted_at" timestamp with time zone
);
--> statement-breakpoint
ALTER TABLE "knowledge_articles" ADD CONSTRAINT "knowledge_articles_category_id_course_categories_id_fk" FOREIGN KEY ("category_id") REFERENCES "public"."course_categories"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "knowledge_articles" ADD CONSTRAINT "knowledge_articles_updated_by_users_id_fk" FOREIGN KEY ("updated_by") REFERENCES "public"."users"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "knowledge_links" ADD CONSTRAINT "knowledge_links_article_id_knowledge_articles_id_fk" FOREIGN KEY ("article_id") REFERENCES "public"."knowledge_articles"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "knowledge_revisions" ADD CONSTRAINT "knowledge_revisions_article_id_knowledge_articles_id_fk" FOREIGN KEY ("article_id") REFERENCES "public"."knowledge_articles"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "knowledge_revisions" ADD CONSTRAINT "knowledge_revisions_author_id_users_id_fk" FOREIGN KEY ("author_id") REFERENCES "public"."users"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "news" ADD CONSTRAINT "news_category_id_course_categories_id_fk" FOREIGN KEY ("category_id") REFERENCES "public"."course_categories"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "news" ADD CONSTRAINT "news_author_id_users_id_fk" FOREIGN KEY ("author_id") REFERENCES "public"."users"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "news_views" ADD CONSTRAINT "news_views_news_id_news_id_fk" FOREIGN KEY ("news_id") REFERENCES "public"."news"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "news_views" ADD CONSTRAINT "news_views_user_id_users_id_fk" FOREIGN KEY ("user_id") REFERENCES "public"."users"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "survey_responses" ADD CONSTRAINT "survey_responses_survey_id_surveys_id_fk" FOREIGN KEY ("survey_id") REFERENCES "public"."surveys"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "survey_responses" ADD CONSTRAINT "survey_responses_user_id_users_id_fk" FOREIGN KEY ("user_id") REFERENCES "public"."users"("id") ON DELETE set null ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "survey_responses" ADD CONSTRAINT "survey_responses_enrollment_id_enrollments_id_fk" FOREIGN KEY ("enrollment_id") REFERENCES "public"."enrollments"("id") ON DELETE set null ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "surveys" ADD CONSTRAINT "surveys_created_by_users_id_fk" FOREIGN KEY ("created_by") REFERENCES "public"."users"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "workshop_comments" ADD CONSTRAINT "workshop_comments_submission_id_workshop_submissions_id_fk" FOREIGN KEY ("submission_id") REFERENCES "public"."workshop_submissions"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "workshop_comments" ADD CONSTRAINT "workshop_comments_author_id_users_id_fk" FOREIGN KEY ("author_id") REFERENCES "public"."users"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "workshop_submissions" ADD CONSTRAINT "workshop_submissions_workshop_id_workshops_id_fk" FOREIGN KEY ("workshop_id") REFERENCES "public"."workshops"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "workshop_submissions" ADD CONSTRAINT "workshop_submissions_user_id_users_id_fk" FOREIGN KEY ("user_id") REFERENCES "public"."users"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "workshop_submissions" ADD CONSTRAINT "workshop_submissions_enrollment_id_enrollments_id_fk" FOREIGN KEY ("enrollment_id") REFERENCES "public"."enrollments"("id") ON DELETE set null ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "workshop_submissions" ADD CONSTRAINT "workshop_submissions_lesson_id_lessons_id_fk" FOREIGN KEY ("lesson_id") REFERENCES "public"."lessons"("id") ON DELETE set null ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "workshop_submissions" ADD CONSTRAINT "workshop_submissions_reviewer_id_users_id_fk" FOREIGN KEY ("reviewer_id") REFERENCES "public"."users"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
CREATE INDEX "knowledge_articles_tenant_id_status_index" ON "knowledge_articles" USING btree ("tenant_id","status");--> statement-breakpoint
CREATE INDEX "news_tenant_id_status_published_at_index" ON "news" USING btree ("tenant_id","status","published_at" DESC NULLS LAST);--> statement-breakpoint
CREATE INDEX "workshop_submissions_tenant_id_status_index" ON "workshop_submissions" USING btree ("tenant_id","status");--> statement-breakpoint
CREATE INDEX "workshop_submissions_tenant_id_user_id_workshop_id_index" ON "workshop_submissions" USING btree ("tenant_id","user_id","workshop_id");--> statement-breakpoint
-- RLS (правило CLAUDE.md №4)
DO $$
DECLARE t text;
BEGIN
  FOREACH t IN ARRAY ARRAY[
    'knowledge_articles', 'knowledge_revisions', 'knowledge_links', 'surveys', 'survey_responses',
    'news', 'news_views', 'workshops', 'workshop_submissions', 'workshop_comments'
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
-- FTS: tsvector генерируется триггером из title+summary+plain_text (конфиг simple + unaccent-подобная
-- нормализация; словарь 'ukrainian' в стоковом Postgres отсутствует — docs/00 §0.4 [решение])
CREATE OR REPLACE FUNCTION knowledge_tsv_update() RETURNS trigger LANGUAGE plpgsql AS $$
BEGIN
  NEW.search_tsv :=
    setweight(to_tsvector('simple', coalesce(NEW.title, '')), 'A') ||
    setweight(to_tsvector('simple', coalesce(NEW.summary, '')), 'B') ||
    setweight(to_tsvector('simple', coalesce(NEW.plain_text, '')), 'C') ||
    setweight(to_tsvector('simple', array_to_string(NEW.tags, ' ')), 'B');
  RETURN NEW;
END $$;
--> statement-breakpoint
CREATE TRIGGER knowledge_tsv_trg BEFORE INSERT OR UPDATE OF title, summary, plain_text, tags
  ON knowledge_articles FOR EACH ROW EXECUTE FUNCTION knowledge_tsv_update();
--> statement-breakpoint
CREATE INDEX knowledge_articles_tsv_idx ON knowledge_articles USING gin (search_tsv);
--> statement-breakpoint
-- Уроки тоже ищутся (docs/07 этап 5: «риба температура» находит и статью, и урок)
ALTER TABLE resources ADD COLUMN IF NOT EXISTS plain_text text NOT NULL DEFAULT '';
--> statement-breakpoint
ALTER TABLE resources ADD COLUMN IF NOT EXISTS search_tsv tsvector;
--> statement-breakpoint
CREATE OR REPLACE FUNCTION resources_tsv_update() RETURNS trigger LANGUAGE plpgsql AS $$
BEGIN
  NEW.search_tsv := setweight(to_tsvector('simple', coalesce(NEW.title, '')), 'A') ||
                    setweight(to_tsvector('simple', coalesce(NEW.plain_text, '')), 'C');
  RETURN NEW;
END $$;
--> statement-breakpoint
CREATE TRIGGER resources_tsv_trg BEFORE INSERT OR UPDATE OF title, plain_text
  ON resources FOR EACH ROW EXECUTE FUNCTION resources_tsv_update();
--> statement-breakpoint
CREATE INDEX resources_tsv_idx ON resources USING gin (search_tsv);
--> statement-breakpoint
-- pgvector: ivfflat нужен минимум ~100 строк для обучения; на старте — точный поиск, индекс — миграцией позже
