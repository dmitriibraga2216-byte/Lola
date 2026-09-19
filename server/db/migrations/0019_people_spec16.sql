CREATE TABLE "functional_chiefs" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	"updated_at" timestamp with time zone DEFAULT now() NOT NULL,
	"tenant_id" uuid NOT NULL,
	"user_id" uuid NOT NULL,
	"chief_id" uuid NOT NULL,
	"kind" text DEFAULT 'functional' NOT NULL,
	"scope" text,
	CONSTRAINT "functional_chiefs_user_id_chief_id_kind_unique" UNIQUE("user_id","chief_id","kind")
);
--> statement-breakpoint
CREATE TABLE "user_groups" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	"updated_at" timestamp with time zone DEFAULT now() NOT NULL,
	"tenant_id" uuid NOT NULL,
	"name" text NOT NULL,
	"kind" text DEFAULT 'static' NOT NULL,
	"members" uuid[] DEFAULT '{}'::uuid[] NOT NULL,
	"filter" jsonb,
	"is_active" boolean DEFAULT true NOT NULL,
	"recalc_at" timestamp with time zone,
	CONSTRAINT "user_groups_tenant_id_name_unique" UNIQUE("tenant_id","name")
);
--> statement-breakpoint
CREATE TABLE "user_notes" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	"updated_at" timestamp with time zone DEFAULT now() NOT NULL,
	"tenant_id" uuid NOT NULL,
	"user_id" uuid NOT NULL,
	"author_id" uuid,
	"body" text NOT NULL
);
--> statement-breakpoint
ALTER TABLE "locations" ADD COLUMN "city_id" uuid;--> statement-breakpoint
ALTER TABLE "positions" ADD COLUMN "is_active" boolean DEFAULT true NOT NULL;--> statement-breakpoint
ALTER TABLE "user_placements" ADD COLUMN "position_level_id" uuid;--> statement-breakpoint
ALTER TABLE "user_placements" ADD COLUMN "city_id" uuid;--> statement-breakpoint
ALTER TABLE "user_placements" ADD COLUMN "org_unit_id" uuid;--> statement-breakpoint
ALTER TABLE "users" ADD COLUMN "last_name" text;--> statement-breakpoint
ALTER TABLE "users" ADD COLUMN "first_name" text;--> statement-breakpoint
ALTER TABLE "users" ADD COLUMN "middle_name" text;--> statement-breakpoint
ALTER TABLE "users" ADD COLUMN "latin_name" text;--> statement-breakpoint
ALTER TABLE "users" ADD COLUMN "work_contacts" jsonb DEFAULT '{}'::jsonb NOT NULL;--> statement-breakpoint
ALTER TABLE "users" ADD COLUMN "birth_date" date;--> statement-breakpoint
ALTER TABLE "users" ADD COLUMN "gender" text;--> statement-breakpoint
ALTER TABLE "users" ADD COLUMN "position_since" date;--> statement-breakpoint
ALTER TABLE "users" ADD COLUMN "comment" text;--> statement-breakpoint
ALTER TABLE "users" ADD COLUMN "is_blocked" boolean DEFAULT false NOT NULL;--> statement-breakpoint
ALTER TABLE "users" ADD COLUMN "is_hidden" boolean DEFAULT false NOT NULL;--> statement-breakpoint
ALTER TABLE "cities" ADD COLUMN "is_active" boolean DEFAULT true NOT NULL;--> statement-breakpoint
ALTER TABLE "tags" ADD COLUMN "color" text;--> statement-breakpoint
ALTER TABLE "tags" ADD COLUMN "kind" text DEFAULT 'any' NOT NULL;--> statement-breakpoint
ALTER TABLE "import_jobs" ADD COLUMN "source" text DEFAULT 'csv' NOT NULL;--> statement-breakpoint
ALTER TABLE "import_jobs" ADD COLUMN "mapping" jsonb;--> statement-breakpoint
ALTER TABLE "import_jobs" ADD COLUMN "options" jsonb DEFAULT '{}' NOT NULL;--> statement-breakpoint
ALTER TABLE "import_jobs" ADD COLUMN "report_key" text;--> statement-breakpoint
ALTER TABLE "import_jobs" ADD COLUMN "started_at" timestamp with time zone;--> statement-breakpoint
ALTER TABLE "import_jobs" ADD COLUMN "finished_at" timestamp with time zone;--> statement-breakpoint
ALTER TABLE "functional_chiefs" ADD CONSTRAINT "functional_chiefs_user_id_users_id_fk" FOREIGN KEY ("user_id") REFERENCES "public"."users"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "functional_chiefs" ADD CONSTRAINT "functional_chiefs_chief_id_users_id_fk" FOREIGN KEY ("chief_id") REFERENCES "public"."users"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "user_notes" ADD CONSTRAINT "user_notes_user_id_users_id_fk" FOREIGN KEY ("user_id") REFERENCES "public"."users"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "user_notes" ADD CONSTRAINT "user_notes_author_id_users_id_fk" FOREIGN KEY ("author_id") REFERENCES "public"."users"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "user_placements" ADD CONSTRAINT "user_placements_position_level_id_position_levels_id_fk" FOREIGN KEY ("position_level_id") REFERENCES "public"."position_levels"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "user_placements" ADD CONSTRAINT "user_placements_city_id_cities_id_fk" FOREIGN KEY ("city_id") REFERENCES "public"."cities"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "user_placements" ADD CONSTRAINT "user_placements_org_unit_id_org_units_id_fk" FOREIGN KEY ("org_unit_id") REFERENCES "public"."org_units"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
-- Разбить ФИО на части у существующих (docs/16 §3.1): «Прізвище Імʼя По батькові»
UPDATE users SET last_name = split_part(full_name, ' ', 1), first_name = nullif(split_part(full_name, ' ', 2), ''), middle_name = nullif(split_part(full_name, ' ', 3), '') WHERE last_name IS NULL;
--> statement-breakpoint
-- Подразделение и город размещения — из точки
UPDATE user_placements up SET org_unit_id = l.org_unit_id, city_id = coalesce(up.city_id, l.city_id) FROM locations l WHERE l.id = up.location_id AND up.org_unit_id IS NULL;
--> statement-breakpoint
DO $$
DECLARE t text;
BEGIN
  FOREACH t IN ARRAY ARRAY['user_groups', 'functional_chiefs', 'user_notes']
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
