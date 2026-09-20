CREATE TABLE "bookmarks" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	"updated_at" timestamp with time zone DEFAULT now() NOT NULL,
	"tenant_id" uuid NOT NULL,
	"user_id" uuid NOT NULL,
	"content_type" text NOT NULL,
	"content_id" uuid NOT NULL,
	CONSTRAINT "bookmarks_tenant_id_user_id_content_type_content_id_unique" UNIQUE("tenant_id","user_id","content_type","content_id")
);
--> statement-breakpoint
CREATE TABLE "notice_acks" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	"updated_at" timestamp with time zone DEFAULT now() NOT NULL,
	"tenant_id" uuid NOT NULL,
	"notice_id" uuid NOT NULL,
	"user_id" uuid NOT NULL,
	"acked_at" timestamp with time zone DEFAULT now() NOT NULL,
	"request_context" jsonb,
	CONSTRAINT "notice_acks_tenant_id_notice_id_user_id_unique" UNIQUE("tenant_id","notice_id","user_id")
);
--> statement-breakpoint
CREATE TABLE "notices" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	"updated_at" timestamp with time zone DEFAULT now() NOT NULL,
	"tenant_id" uuid NOT NULL,
	"title" text NOT NULL,
	"body" jsonb DEFAULT '[]' NOT NULL,
	"attachments" jsonb DEFAULT '[]' NOT NULL,
	"kind" text DEFAULT 'acknowledge' NOT NULL,
	"starts_at" timestamp with time zone,
	"ends_at" timestamp with time zone,
	"show_mode" text DEFAULT 'modal' NOT NULL,
	"priority" text DEFAULT 'normal' NOT NULL,
	"block_until_ack" boolean DEFAULT false NOT NULL,
	"ack_text" text,
	"status" text DEFAULT 'draft' NOT NULL,
	"published_at" timestamp with time zone,
	"views_count" integer DEFAULT 0 NOT NULL,
	"author_id" uuid,
	"deleted_at" timestamp with time zone
);
--> statement-breakpoint
CREATE TABLE "simple_notices" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	"updated_at" timestamp with time zone DEFAULT now() NOT NULL,
	"tenant_id" uuid NOT NULL,
	"title" text NOT NULL,
	"body" jsonb DEFAULT '[]' NOT NULL,
	"published_at" timestamp with time zone,
	"ends_at" timestamp with time zone,
	"status" text DEFAULT 'draft' NOT NULL,
	"views_count" integer DEFAULT 0 NOT NULL,
	"author_id" uuid,
	"deleted_at" timestamp with time zone
);
--> statement-breakpoint
ALTER TABLE "users" ADD COLUMN "birthday_consent" boolean DEFAULT true NOT NULL;--> statement-breakpoint
ALTER TABLE "news" ADD COLUMN "views_count" integer DEFAULT 0 NOT NULL;--> statement-breakpoint
ALTER TABLE "meetups" ADD COLUMN "audience" jsonb;--> statement-breakpoint
ALTER TABLE "bookmarks" ADD CONSTRAINT "bookmarks_user_id_users_id_fk" FOREIGN KEY ("user_id") REFERENCES "public"."users"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "notice_acks" ADD CONSTRAINT "notice_acks_notice_id_notices_id_fk" FOREIGN KEY ("notice_id") REFERENCES "public"."notices"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "notice_acks" ADD CONSTRAINT "notice_acks_user_id_users_id_fk" FOREIGN KEY ("user_id") REFERENCES "public"."users"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "notices" ADD CONSTRAINT "notices_author_id_users_id_fk" FOREIGN KEY ("author_id") REFERENCES "public"."users"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "simple_notices" ADD CONSTRAINT "simple_notices_author_id_users_id_fk" FOREIGN KEY ("author_id") REFERENCES "public"."users"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
CREATE INDEX "notices_tenant_id_status_published_at_index" ON "notices" USING btree ("tenant_id","status","published_at" DESC NULLS LAST);--> statement-breakpoint
CREATE INDEX "simple_notices_tenant_id_status_index" ON "simple_notices" USING btree ("tenant_id","status");;--> statement-breakpoint
-- Перечисления и допустимые значения (docs/02): content_type получает notice (Spec 21)
ALTER TABLE "assignments" DROP CONSTRAINT "assignments_subject_type_content_type";--> statement-breakpoint
ALTER TABLE "assignments" ADD CONSTRAINT "assignments_subject_type_content_type" CHECK ("subject_type" IN ('course', 'training_program', 'resource', 'test', 'complex_test', 'workshop', 'poll', 'assessment', 'check_list', 'meetup', 'webinar', 'notice'));--> statement-breakpoint
ALTER TABLE "trajectory_nodes" DROP CONSTRAINT "trajectory_nodes_content_type_content_type";--> statement-breakpoint
ALTER TABLE "trajectory_nodes" ADD CONSTRAINT "trajectory_nodes_content_type_content_type" CHECK ("content_type" IS NULL OR "content_type" IN ('course', 'training_program', 'resource', 'test', 'complex_test', 'workshop', 'poll', 'assessment', 'check_list', 'meetup', 'webinar', 'notice'));--> statement-breakpoint
ALTER TABLE "task_access_log" DROP CONSTRAINT "task_access_log_content_type_content_type";--> statement-breakpoint
ALTER TABLE "task_access_log" ADD CONSTRAINT "task_access_log_content_type_content_type" CHECK ("content_type" IN ('course', 'training_program', 'resource', 'test', 'complex_test', 'workshop', 'poll', 'assessment', 'check_list', 'meetup', 'webinar', 'notice', 'news', 'simple_notice', 'article'));--> statement-breakpoint
ALTER TABLE "notices" ADD CONSTRAINT "notices_kind_notice_kind" CHECK ("kind" IN ('acknowledge', 'event', 'notification'));--> statement-breakpoint
ALTER TABLE "notices" ADD CONSTRAINT "notices_show_mode_check" CHECK ("show_mode" IN ('modal', 'banner', 'both'));--> statement-breakpoint
ALTER TABLE "notices" ADD CONSTRAINT "notices_priority_check" CHECK ("priority" IN ('normal', 'important', 'critical'));--> statement-breakpoint
ALTER TABLE "notices" ADD CONSTRAINT "notices_status_check" CHECK ("status" IN ('draft', 'published', 'archived'));--> statement-breakpoint
ALTER TABLE "simple_notices" ADD CONSTRAINT "simple_notices_status_check" CHECK ("status" IN ('draft', 'published', 'archived'));--> statement-breakpoint
ALTER TABLE "bookmarks" ADD CONSTRAINT "bookmarks_content_type_check" CHECK ("content_type" IN ('resource', 'article', 'news', 'notice'));--> statement-breakpoint
-- Таблицы тенанта — RLS обязателен (CLAUDE.md п. 1)
ALTER TABLE notices ENABLE ROW LEVEL SECURITY;--> statement-breakpoint
ALTER TABLE notices FORCE ROW LEVEL SECURITY;--> statement-breakpoint
CREATE POLICY tenant_isolation ON notices
  USING (tenant_id = nullif(current_setting('app.tenant_id', true), '')::uuid)
  WITH CHECK (tenant_id = nullif(current_setting('app.tenant_id', true), '')::uuid);--> statement-breakpoint
ALTER TABLE notice_acks ENABLE ROW LEVEL SECURITY;--> statement-breakpoint
ALTER TABLE notice_acks FORCE ROW LEVEL SECURITY;--> statement-breakpoint
CREATE POLICY tenant_isolation ON notice_acks
  USING (tenant_id = nullif(current_setting('app.tenant_id', true), '')::uuid)
  WITH CHECK (tenant_id = nullif(current_setting('app.tenant_id', true), '')::uuid);--> statement-breakpoint
ALTER TABLE simple_notices ENABLE ROW LEVEL SECURITY;--> statement-breakpoint
ALTER TABLE simple_notices FORCE ROW LEVEL SECURITY;--> statement-breakpoint
CREATE POLICY tenant_isolation ON simple_notices
  USING (tenant_id = nullif(current_setting('app.tenant_id', true), '')::uuid)
  WITH CHECK (tenant_id = nullif(current_setting('app.tenant_id', true), '')::uuid);--> statement-breakpoint
ALTER TABLE bookmarks ENABLE ROW LEVEL SECURITY;--> statement-breakpoint
ALTER TABLE bookmarks FORCE ROW LEVEL SECURITY;--> statement-breakpoint
CREATE POLICY tenant_isolation ON bookmarks
  USING (tenant_id = nullif(current_setting('app.tenant_id', true), '')::uuid)
  WITH CHECK (tenant_id = nullif(current_setting('app.tenant_id', true), '')::uuid);--> statement-breakpoint
-- Перенос объявлений из news (kind=announcement) в notices (docs/30 §4, долг news.ack_due_at):
-- объявление → notices; срок подтверждения → назначение (assignments, subject_type=notice, due_mode=absolute);
-- подтверждения из news_views.acked_at → notice_acks. Аудитория «все» = сегмент активных.
INSERT INTO "notices" ("id", "tenant_id", "created_at", "updated_at", "title", "body", "kind", "starts_at", "ends_at", "show_mode", "priority", "block_until_ack", "ack_text", "status", "published_at", "author_id", "deleted_at")
SELECT n."id", n."tenant_id", n."created_at", n."updated_at", n."title", n."body",
  CASE WHEN n."requires_ack" THEN 'acknowledge' ELSE 'notification' END,
  n."publish_at", n."unpublish_at", n."show_mode", n."priority", n."block_until_ack", n."ack_text",
  CASE WHEN n."status" IN ('published', 'scheduled') THEN 'published' WHEN n."status" = 'archived' THEN 'archived' ELSE 'draft' END,
  n."published_at", n."author_id", n."deleted_at"
FROM "news" n WHERE n."kind" = 'announcement';--> statement-breakpoint
INSERT INTO "notice_acks" ("tenant_id", "notice_id", "user_id", "acked_at", "created_at")
SELECT v."tenant_id", v."news_id", v."user_id", v."acked_at", v."acked_at"
FROM "news_views" v JOIN "news" n ON n."id" = v."news_id" AND n."kind" = 'announcement'
WHERE v."acked_at" IS NOT NULL;--> statement-breakpoint
INSERT INTO "assignments" ("tenant_id", "title", "kind", "subject_type", "subject_id", "audience", "exclude", "starts_at", "due_mode", "due_at", "due_days", "is_mandatory", "params", "reminders", "auto_sync", "status", "created_by")
SELECT n."tenant_id", n."title", 'manual', 'notice', n."id",
  COALESCE(n."audience", '{"rules":[{"type":"segment","filter":{"status":["active"]}}],"match":"any"}'::jsonb),
  '{"rules":[],"match":"any"}'::jsonb, n."publish_at",
  CASE WHEN n."ack_due_at" IS NULL THEN 'none' ELSE 'absolute' END, n."ack_due_at", NULL, true,
  '{}'::jsonb, '{}'::jsonb, true,
  CASE WHEN n."status" IN ('published', 'scheduled') AND n."deleted_at" IS NULL THEN 'active' ELSE 'archived' END,
  n."author_id"
FROM "news" n WHERE n."kind" = 'announcement';--> statement-breakpoint
DELETE FROM "news" WHERE "kind" = 'announcement';--> statement-breakpoint
ALTER TABLE "news" DROP COLUMN "kind";--> statement-breakpoint
ALTER TABLE "news" DROP COLUMN "ack_due_at";--> statement-breakpoint
ALTER TABLE "news" DROP COLUMN "show_mode";--> statement-breakpoint
ALTER TABLE "news" DROP COLUMN "priority";--> statement-breakpoint
ALTER TABLE "news" DROP COLUMN "block_until_ack";--> statement-breakpoint
ALTER TABLE "news" DROP COLUMN "ack_text";--> statement-breakpoint
-- views_count новостей: по уже накопленным просмотрам (раз на человека)
UPDATE "news" n SET "views_count" = (SELECT count(*) FROM "news_views" v WHERE v."news_id" = n."id");
