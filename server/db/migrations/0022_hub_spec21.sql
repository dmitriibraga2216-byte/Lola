CREATE TABLE "knowledge_feedback" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	"updated_at" timestamp with time zone DEFAULT now() NOT NULL,
	"tenant_id" uuid NOT NULL,
	"article_id" uuid NOT NULL,
	"user_id" uuid NOT NULL,
	"helpful" boolean NOT NULL,
	"comment" text,
	CONSTRAINT "knowledge_feedback_tenant_id_article_id_user_id_unique" UNIQUE("tenant_id","article_id","user_id")
);
--> statement-breakpoint
CREATE TABLE "search_queries" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	"updated_at" timestamp with time zone DEFAULT now() NOT NULL,
	"tenant_id" uuid NOT NULL,
	"user_id" uuid,
	"query" text NOT NULL,
	"results" integer DEFAULT 0 NOT NULL
);
--> statement-breakpoint
ALTER TABLE "knowledge_articles" ADD COLUMN "helpful_count" integer DEFAULT 0 NOT NULL;--> statement-breakpoint
ALTER TABLE "knowledge_articles" ADD COLUMN "not_helpful_count" integer DEFAULT 0 NOT NULL;--> statement-breakpoint
ALTER TABLE "knowledge_articles" ADD COLUMN "review_at" date;--> statement-breakpoint
ALTER TABLE "knowledge_articles" ADD COLUMN "review_confirmed_at" timestamp with time zone;--> statement-breakpoint
ALTER TABLE "knowledge_articles" ADD COLUMN "owner_id" uuid;--> statement-breakpoint
ALTER TABLE "knowledge_articles" ADD COLUMN "related_courses" uuid[] DEFAULT '{}'::uuid[] NOT NULL;--> statement-breakpoint
ALTER TABLE "knowledge_articles" ADD COLUMN "related_articles" uuid[] DEFAULT '{}'::uuid[] NOT NULL;--> statement-breakpoint
ALTER TABLE "knowledge_articles" ADD COLUMN "attachments" jsonb DEFAULT '[]' NOT NULL;--> statement-breakpoint
ALTER TABLE "news" ADD COLUMN "lead" text;--> statement-breakpoint
ALTER TABLE "news" ADD COLUMN "publish_at" timestamp with time zone;--> statement-breakpoint
ALTER TABLE "news" ADD COLUMN "unpublish_at" timestamp with time zone;--> statement-breakpoint
ALTER TABLE "news" ADD COLUMN "comments_enabled" boolean DEFAULT false NOT NULL;--> statement-breakpoint
ALTER TABLE "news" ADD COLUMN "show_mode" text DEFAULT 'modal' NOT NULL;--> statement-breakpoint
ALTER TABLE "news" ADD COLUMN "priority" text DEFAULT 'normal' NOT NULL;--> statement-breakpoint
ALTER TABLE "news" ADD COLUMN "block_until_ack" boolean DEFAULT false NOT NULL;--> statement-breakpoint
ALTER TABLE "news" ADD COLUMN "ack_text" text;--> statement-breakpoint
ALTER TABLE "news_views" ADD COLUMN "seconds_spent" integer DEFAULT 0 NOT NULL;--> statement-breakpoint
ALTER TABLE "news_views" ADD COLUMN "scrolled_to_end" boolean DEFAULT false NOT NULL;--> statement-breakpoint
ALTER TABLE "meetup_registrations" ADD COLUMN "guests_count" integer DEFAULT 0 NOT NULL;--> statement-breakpoint
ALTER TABLE "meetups" ADD COLUMN "cover_key" text;--> statement-breakpoint
ALTER TABLE "meetups" ADD COLUMN "registration_required" boolean DEFAULT true NOT NULL;--> statement-breakpoint
ALTER TABLE "wiki_pages" ADD COLUMN "locked_by" uuid;--> statement-breakpoint
ALTER TABLE "wiki_pages" ADD COLUMN "locked_at" timestamp with time zone;--> statement-breakpoint
ALTER TABLE "knowledge_feedback" ADD CONSTRAINT "knowledge_feedback_article_id_knowledge_articles_id_fk" FOREIGN KEY ("article_id") REFERENCES "public"."knowledge_articles"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "knowledge_feedback" ADD CONSTRAINT "knowledge_feedback_user_id_users_id_fk" FOREIGN KEY ("user_id") REFERENCES "public"."users"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "search_queries" ADD CONSTRAINT "search_queries_user_id_users_id_fk" FOREIGN KEY ("user_id") REFERENCES "public"."users"("id") ON DELETE set null ON UPDATE no action;--> statement-breakpoint
CREATE INDEX "search_queries_tenant_id_results_created_at_index" ON "search_queries" USING btree ("tenant_id","results","created_at" DESC NULLS LAST);--> statement-breakpoint
ALTER TABLE "knowledge_articles" ADD CONSTRAINT "knowledge_articles_owner_id_users_id_fk" FOREIGN KEY ("owner_id") REFERENCES "public"."users"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "wiki_pages" ADD CONSTRAINT "wiki_pages_locked_by_users_id_fk" FOREIGN KEY ("locked_by") REFERENCES "public"."users"("id") ON DELETE no action ON UPDATE no action;
--> statement-breakpoint
DO $$
DECLARE t text;
BEGIN
  FOREACH t IN ARRAY ARRAY['knowledge_feedback', 'search_queries']
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
-- Владелец статьи по умолчанию — последний редактор (docs/21 §3.1 owner_id обязателен)
UPDATE knowledge_articles SET owner_id = updated_by WHERE owner_id IS NULL;
