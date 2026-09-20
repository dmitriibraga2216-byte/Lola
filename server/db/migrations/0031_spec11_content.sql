CREATE TABLE "access_group_members" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	"updated_at" timestamp with time zone DEFAULT now() NOT NULL,
	"tenant_id" uuid NOT NULL,
	"group_id" uuid NOT NULL,
	"subject_type" text NOT NULL,
	"subject_id" uuid NOT NULL,
	CONSTRAINT "access_group_members_tenant_id_group_id_subject_type_subject_id_unique" UNIQUE("tenant_id","group_id","subject_type","subject_id")
);
--> statement-breakpoint
CREATE TABLE "access_groups" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	"updated_at" timestamp with time zone DEFAULT now() NOT NULL,
	"tenant_id" uuid NOT NULL,
	"name" text NOT NULL,
	"description" text,
	"applies_to" text DEFAULT 'knowledge' NOT NULL,
	CONSTRAINT "access_groups_tenant_id_name_applies_to_unique" UNIQUE("tenant_id","name","applies_to")
);
--> statement-breakpoint
CREATE TABLE "content_access_groups" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	"updated_at" timestamp with time zone DEFAULT now() NOT NULL,
	"tenant_id" uuid NOT NULL,
	"content_type" text NOT NULL,
	"content_id" uuid NOT NULL,
	"group_id" uuid NOT NULL,
	CONSTRAINT "content_access_groups_tenant_id_content_type_content_id_group_id_unique" UNIQUE("tenant_id","content_type","content_id","group_id")
);
--> statement-breakpoint
CREATE TABLE "resource_categories" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	"updated_at" timestamp with time zone DEFAULT now() NOT NULL,
	"tenant_id" uuid NOT NULL,
	"parent_id" uuid,
	"name" text NOT NULL,
	"sort_order" integer DEFAULT 0 NOT NULL
);
--> statement-breakpoint
CREATE TABLE "resource_versions" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	"updated_at" timestamp with time zone DEFAULT now() NOT NULL,
	"tenant_id" uuid NOT NULL,
	"resource_id" uuid NOT NULL,
	"version" integer NOT NULL,
	"title" text NOT NULL,
	"kind" text NOT NULL,
	"body" jsonb DEFAULT '[]' NOT NULL,
	"plain_text" text DEFAULT '' NOT NULL,
	"media_id" uuid,
	"external_url" text,
	"changelog" text,
	"published_at" timestamp with time zone DEFAULT now() NOT NULL,
	"published_by" uuid,
	CONSTRAINT "resource_versions_tenant_id_resource_id_version_unique" UNIQUE("tenant_id","resource_id","version")
);
--> statement-breakpoint
ALTER TABLE "courses" ADD COLUMN "code" text;--> statement-breakpoint
ALTER TABLE "courses" ADD COLUMN "icon_key" text;--> statement-breakpoint
ALTER TABLE "courses" ADD COLUMN "duration_days" integer;--> statement-breakpoint
ALTER TABLE "courses" ADD COLUMN "workload" text;--> statement-breakpoint
ALTER TABLE "courses" ADD COLUMN "result_mode" text DEFAULT 'pct' NOT NULL;--> statement-breakpoint
ALTER TABLE "lessons" ADD COLUMN "resource_version_id" uuid;--> statement-breakpoint
ALTER TABLE "resources" ADD COLUMN "category_ids" uuid[] DEFAULT '{}'::uuid[] NOT NULL;--> statement-breakpoint
ALTER TABLE "resources" ADD COLUMN "card_image_key" text;--> statement-breakpoint
ALTER TABLE "resources" ADD COLUMN "allow_print" boolean DEFAULT true NOT NULL;--> statement-breakpoint
ALTER TABLE "resources" ADD COLUMN "published_version_id" uuid;--> statement-breakpoint
ALTER TABLE "resources" ADD COLUMN "views_count" integer DEFAULT 0 NOT NULL;--> statement-breakpoint
ALTER TABLE "lesson_progress" ADD COLUMN "scroll_pct" integer DEFAULT 0 NOT NULL;--> statement-breakpoint
ALTER TABLE "lesson_progress" ADD COLUMN "acknowledged_at" timestamp with time zone;--> statement-breakpoint
ALTER TABLE "lesson_progress" ADD COLUMN "downloaded_at" timestamp with time zone;--> statement-breakpoint
ALTER TABLE "access_group_members" ADD CONSTRAINT "access_group_members_group_id_access_groups_id_fk" FOREIGN KEY ("group_id") REFERENCES "public"."access_groups"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "content_access_groups" ADD CONSTRAINT "content_access_groups_group_id_access_groups_id_fk" FOREIGN KEY ("group_id") REFERENCES "public"."access_groups"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "resource_categories" ADD CONSTRAINT "resource_categories_parent_id_resource_categories_id_fk" FOREIGN KEY ("parent_id") REFERENCES "public"."resource_categories"("id") ON DELETE set null ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "resource_versions" ADD CONSTRAINT "resource_versions_resource_id_resources_id_fk" FOREIGN KEY ("resource_id") REFERENCES "public"."resources"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "resource_versions" ADD CONSTRAINT "resource_versions_published_by_users_id_fk" FOREIGN KEY ("published_by") REFERENCES "public"."users"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
CREATE INDEX "resource_categories_tenant_id_sort_order_index" ON "resource_categories" USING btree ("tenant_id","sort_order");--> statement-breakpoint
ALTER TABLE "lessons" ADD CONSTRAINT "lessons_resource_version_id_resource_versions_id_fk" FOREIGN KEY ("resource_version_id") REFERENCES "public"."resource_versions"("id") ON DELETE set null ON UPDATE no action;--> statement-breakpoint
CREATE INDEX "resources_tenant_id_status_index" ON "resources" USING btree ("tenant_id","status");--> statement-breakpoint
-- Перечисления по docs/11 §3.1 (scorm — R3), docs/02 §2.4 и docs/02 access_group_members
ALTER TABLE "resources" ADD CONSTRAINT "resources_kind_check" CHECK ("kind" IN ('article', 'file', 'video', 'link'));--> statement-breakpoint
ALTER TABLE "resources" ADD CONSTRAINT "resources_status_check" CHECK ("status" IN ('draft', 'published', 'archived'));--> statement-breakpoint
ALTER TABLE "courses" ADD CONSTRAINT "courses_result_mode_check" CHECK ("result_mode" IN ('pct', 'avg_score', 'final_test'));--> statement-breakpoint
ALTER TABLE "access_groups" ADD CONSTRAINT "access_groups_applies_to_check" CHECK ("applies_to" IN ('knowledge', 'catalog'));--> statement-breakpoint
ALTER TABLE "access_group_members" ADD CONSTRAINT "access_group_members_subject_type_check" CHECK ("subject_type" IN ('position', 'org_unit', 'user', 'role'));--> statement-breakpoint
-- Опубликованные ресурсы получают снимок версии 1 (Г-11.3), чтобы курсы могли закрепиться за версией
INSERT INTO "resource_versions" ("tenant_id", "resource_id", "version", "title", "kind", "body", "plain_text", "media_id", "external_url", "published_at")
  SELECT "tenant_id", "id", "version", "title", "kind", "body", "plain_text", "media_id", "external_url", "updated_at"
  FROM "resources" WHERE "status" = 'published' AND "deleted_at" IS NULL;--> statement-breakpoint
UPDATE "resources" r SET "published_version_id" = v."id"
  FROM "resource_versions" v WHERE v."resource_id" = r."id" AND v."version" = r."version" AND r."status" = 'published';--> statement-breakpoint
-- Таблицы тенанта — RLS обязателен (CLAUDE.md п. 1)
ALTER TABLE resource_categories ENABLE ROW LEVEL SECURITY;--> statement-breakpoint
ALTER TABLE resource_categories FORCE ROW LEVEL SECURITY;--> statement-breakpoint
CREATE POLICY tenant_isolation ON resource_categories
  USING (tenant_id = nullif(current_setting('app.tenant_id', true), '')::uuid)
  WITH CHECK (tenant_id = nullif(current_setting('app.tenant_id', true), '')::uuid);--> statement-breakpoint
ALTER TABLE resource_versions ENABLE ROW LEVEL SECURITY;--> statement-breakpoint
ALTER TABLE resource_versions FORCE ROW LEVEL SECURITY;--> statement-breakpoint
CREATE POLICY tenant_isolation ON resource_versions
  USING (tenant_id = nullif(current_setting('app.tenant_id', true), '')::uuid)
  WITH CHECK (tenant_id = nullif(current_setting('app.tenant_id', true), '')::uuid);--> statement-breakpoint
ALTER TABLE access_groups ENABLE ROW LEVEL SECURITY;--> statement-breakpoint
ALTER TABLE access_groups FORCE ROW LEVEL SECURITY;--> statement-breakpoint
CREATE POLICY tenant_isolation ON access_groups
  USING (tenant_id = nullif(current_setting('app.tenant_id', true), '')::uuid)
  WITH CHECK (tenant_id = nullif(current_setting('app.tenant_id', true), '')::uuid);--> statement-breakpoint
ALTER TABLE access_group_members ENABLE ROW LEVEL SECURITY;--> statement-breakpoint
ALTER TABLE access_group_members FORCE ROW LEVEL SECURITY;--> statement-breakpoint
CREATE POLICY tenant_isolation ON access_group_members
  USING (tenant_id = nullif(current_setting('app.tenant_id', true), '')::uuid)
  WITH CHECK (tenant_id = nullif(current_setting('app.tenant_id', true), '')::uuid);--> statement-breakpoint
ALTER TABLE content_access_groups ENABLE ROW LEVEL SECURITY;--> statement-breakpoint
ALTER TABLE content_access_groups FORCE ROW LEVEL SECURITY;--> statement-breakpoint
CREATE POLICY tenant_isolation ON content_access_groups
  USING (tenant_id = nullif(current_setting('app.tenant_id', true), '')::uuid)
  WITH CHECK (tenant_id = nullif(current_setting('app.tenant_id', true), '')::uuid);
