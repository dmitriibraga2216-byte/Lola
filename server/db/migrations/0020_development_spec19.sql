CREATE TABLE "competency_categories" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	"updated_at" timestamp with time zone DEFAULT now() NOT NULL,
	"tenant_id" uuid NOT NULL,
	"name" text NOT NULL,
	"sort" integer DEFAULT 0 NOT NULL,
	CONSTRAINT "competency_categories_tenant_id_name_unique" UNIQUE("tenant_id","name")
);
--> statement-breakpoint
CREATE TABLE "strategic_plans" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	"updated_at" timestamp with time zone DEFAULT now() NOT NULL,
	"tenant_id" uuid NOT NULL,
	"title" text NOT NULL,
	"period_from" date NOT NULL,
	"period_to" date NOT NULL,
	"org_unit_id" uuid,
	"goals" jsonb DEFAULT '[]' NOT NULL,
	"budget" numeric(14, 2),
	"kpi" jsonb DEFAULT '[]' NOT NULL,
	"owner_id" uuid,
	"status" text DEFAULT 'draft' NOT NULL
);
--> statement-breakpoint
ALTER TABLE "competencies" DROP CONSTRAINT "competencies_category_id_course_categories_id_fk";
--> statement-breakpoint
-- Старые ссылки на категории курсов не переносятся: справочник категорий компетенций отдельный (docs/19 §3.1)
UPDATE "competencies" SET category_id = NULL WHERE category_id IS NOT NULL;
--> statement-breakpoint
ALTER TABLE "courses" ADD COLUMN "competency_id" uuid;--> statement-breakpoint
ALTER TABLE "courses" ADD COLUMN "competency_level" integer;--> statement-breakpoint
ALTER TABLE "development_goals" ADD COLUMN "approved_by" uuid;--> statement-breakpoint
ALTER TABLE "development_goals" ADD COLUMN "approved_at" timestamp with time zone;--> statement-breakpoint
ALTER TABLE "development_goals" ADD COLUMN "return_comment" text;--> statement-breakpoint
ALTER TABLE "strategic_plans" ADD CONSTRAINT "strategic_plans_org_unit_id_org_units_id_fk" FOREIGN KEY ("org_unit_id") REFERENCES "public"."org_units"("id") ON DELETE set null ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "strategic_plans" ADD CONSTRAINT "strategic_plans_owner_id_users_id_fk" FOREIGN KEY ("owner_id") REFERENCES "public"."users"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
CREATE INDEX "strategic_plans_tenant_id_status_index" ON "strategic_plans" USING btree ("tenant_id","status");--> statement-breakpoint
ALTER TABLE "competencies" ADD CONSTRAINT "competencies_category_id_competency_categories_id_fk" FOREIGN KEY ("category_id") REFERENCES "public"."competency_categories"("id") ON DELETE set null ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "development_goals" ADD CONSTRAINT "development_goals_approved_by_users_id_fk" FOREIGN KEY ("approved_by") REFERENCES "public"."users"("id") ON DELETE no action ON UPDATE no action;
--> statement-breakpoint
DO $$
DECLARE t text;
BEGIN
  FOREACH t IN ARRAY ARRAY['competency_categories', 'strategic_plans']
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
