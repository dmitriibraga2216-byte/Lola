CREATE TABLE "push_subscriptions" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	"updated_at" timestamp with time zone DEFAULT now() NOT NULL,
	"tenant_id" uuid NOT NULL,
	"user_id" uuid NOT NULL,
	"endpoint" text NOT NULL,
	"p256dh" text NOT NULL,
	"auth" text NOT NULL,
	"user_agent" text,
	"last_seen_at" timestamp with time zone DEFAULT now() NOT NULL,
	CONSTRAINT "push_subscriptions_endpoint_unique" UNIQUE("endpoint")
);
--> statement-breakpoint
CREATE TABLE "content_ratings" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	"updated_at" timestamp with time zone DEFAULT now() NOT NULL,
	"tenant_id" uuid NOT NULL,
	"content_type" text NOT NULL,
	"content_id" uuid NOT NULL,
	"user_id" uuid NOT NULL,
	"value" integer NOT NULL,
	CONSTRAINT "content_ratings_tenant_id_content_type_content_id_user_id_unique" UNIQUE("tenant_id","content_type","content_id","user_id"),
	CONSTRAINT "content_ratings_value_check" CHECK ("content_ratings"."value" between 1 and 5),
	CONSTRAINT "content_ratings_content_type_check" CHECK ("content_ratings"."content_type" in ('resource', 'knowledge_article'))
);
--> statement-breakpoint
ALTER TABLE "tenants" ADD COLUMN "custom_domain" text;--> statement-breakpoint
ALTER TABLE "push_subscriptions" ADD CONSTRAINT "push_subscriptions_user_id_users_id_fk" FOREIGN KEY ("user_id") REFERENCES "public"."users"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "content_ratings" ADD CONSTRAINT "content_ratings_user_id_users_id_fk" FOREIGN KEY ("user_id") REFERENCES "public"."users"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
CREATE INDEX "push_subscriptions_tenant_id_user_id_index" ON "push_subscriptions" USING btree ("tenant_id","user_id");--> statement-breakpoint
CREATE INDEX "content_ratings_tenant_id_content_type_content_id_index" ON "content_ratings" USING btree ("tenant_id","content_type","content_id");--> statement-breakpoint
ALTER TABLE "tenants" ADD CONSTRAINT "tenants_custom_domain_unique" UNIQUE("custom_domain");--> statement-breakpoint
-- D-015 cloze (докс/33): новый тип вопроса — расширяем CHECK на questions.kind (миграция 0030)
ALTER TABLE "questions" DROP CONSTRAINT "questions_kind_check";--> statement-breakpoint
ALTER TABLE "questions" ADD CONSTRAINT "questions_kind_check" CHECK ("kind" IN ('single', 'multi', 'free', 'ordering', 'classification', 'comparison', 'answer_by_map', 'number', 'text_short', 'file', 'cloze'));--> statement-breakpoint
-- Таблицы тенанта — RLS обязателен (CLAUDE.md п. 1)
ALTER TABLE push_subscriptions ENABLE ROW LEVEL SECURITY;--> statement-breakpoint
ALTER TABLE push_subscriptions FORCE ROW LEVEL SECURITY;--> statement-breakpoint
CREATE POLICY tenant_isolation ON push_subscriptions
  USING (tenant_id = nullif(current_setting('app.tenant_id', true), '')::uuid)
  WITH CHECK (tenant_id = nullif(current_setting('app.tenant_id', true), '')::uuid);--> statement-breakpoint
ALTER TABLE content_ratings ENABLE ROW LEVEL SECURITY;--> statement-breakpoint
ALTER TABLE content_ratings FORCE ROW LEVEL SECURITY;--> statement-breakpoint
CREATE POLICY tenant_isolation ON content_ratings
  USING (tenant_id = nullif(current_setting('app.tenant_id', true), '')::uuid)
  WITH CHECK (tenant_id = nullif(current_setting('app.tenant_id', true), '')::uuid);
