CREATE TABLE "program_edges" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	"updated_at" timestamp with time zone DEFAULT now() NOT NULL,
	"tenant_id" uuid NOT NULL,
	"program_id" uuid NOT NULL,
	"from_node_id" uuid NOT NULL,
	"to_node_id" uuid NOT NULL,
	"condition" jsonb DEFAULT '{"type":"always"}' NOT NULL,
	"sort" integer DEFAULT 0 NOT NULL,
	CONSTRAINT "program_edges_from_node_id_to_node_id_unique" UNIQUE("from_node_id","to_node_id")
);
--> statement-breakpoint
CREATE TABLE "program_enrollments" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	"updated_at" timestamp with time zone DEFAULT now() NOT NULL,
	"tenant_id" uuid NOT NULL,
	"program_id" uuid NOT NULL,
	"user_id" uuid NOT NULL,
	"program_version" integer DEFAULT 1 NOT NULL,
	"status" text DEFAULT 'not_started' NOT NULL,
	"current_node_id" uuid,
	"nodes_state" jsonb DEFAULT '{}' NOT NULL,
	"progress_pct" numeric(5, 2) DEFAULT '0' NOT NULL,
	"source" text DEFAULT 'manual' NOT NULL,
	"assignment_id" uuid,
	"rule_id" uuid,
	"started_at" timestamp with time zone,
	"completed_at" timestamp with time zone,
	"due_at" timestamp with time zone,
	"certificate_id" uuid,
	"last_activity_at" timestamp with time zone,
	CONSTRAINT "program_enrollments_program_id_user_id_program_version_unique" UNIQUE("program_id","user_id","program_version")
);
--> statement-breakpoint
CREATE TABLE "program_nodes" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	"updated_at" timestamp with time zone DEFAULT now() NOT NULL,
	"tenant_id" uuid NOT NULL,
	"program_id" uuid NOT NULL,
	"node_type" text DEFAULT 'item' NOT NULL,
	"item_type" text,
	"item_id" uuid,
	"title_override" text,
	"sort" integer DEFAULT 0 NOT NULL,
	"position" jsonb DEFAULT '{"x":0,"y":0}' NOT NULL,
	"is_required" boolean DEFAULT true NOT NULL,
	"due_days" integer,
	"unlock_after" uuid[] DEFAULT '{}'::uuid[] NOT NULL,
	"unlock_rule" jsonb DEFAULT '{"type":"all"}' NOT NULL
);
--> statement-breakpoint
CREATE TABLE "programs" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	"updated_at" timestamp with time zone DEFAULT now() NOT NULL,
	"tenant_id" uuid NOT NULL,
	"title" text NOT NULL,
	"description" text,
	"mode" text DEFAULT 'linear' NOT NULL,
	"cover_key" text,
	"tags" text[] DEFAULT '{}'::text[] NOT NULL,
	"status" text DEFAULT 'draft' NOT NULL,
	"assignment_mode" text[] DEFAULT '{manual}'::text[] NOT NULL,
	"automation_rule_id" uuid,
	"no_assign_after_finish" boolean DEFAULT false NOT NULL,
	"count_prior_results" boolean DEFAULT true NOT NULL,
	"certificate_template_id" uuid,
	"validity_months" integer,
	"due_days" integer,
	"author_ids" uuid[] DEFAULT '{}'::uuid[] NOT NULL,
	"version" integer DEFAULT 1 NOT NULL,
	"published_at" timestamp with time zone,
	"updated_by" uuid
);
--> statement-breakpoint
ALTER TABLE "program_edges" ADD CONSTRAINT "program_edges_program_id_programs_id_fk" FOREIGN KEY ("program_id") REFERENCES "public"."programs"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "program_edges" ADD CONSTRAINT "program_edges_from_node_id_program_nodes_id_fk" FOREIGN KEY ("from_node_id") REFERENCES "public"."program_nodes"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "program_edges" ADD CONSTRAINT "program_edges_to_node_id_program_nodes_id_fk" FOREIGN KEY ("to_node_id") REFERENCES "public"."program_nodes"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "program_enrollments" ADD CONSTRAINT "program_enrollments_program_id_programs_id_fk" FOREIGN KEY ("program_id") REFERENCES "public"."programs"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "program_enrollments" ADD CONSTRAINT "program_enrollments_user_id_users_id_fk" FOREIGN KEY ("user_id") REFERENCES "public"."users"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "program_nodes" ADD CONSTRAINT "program_nodes_program_id_programs_id_fk" FOREIGN KEY ("program_id") REFERENCES "public"."programs"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "programs" ADD CONSTRAINT "programs_automation_rule_id_automation_rules_id_fk" FOREIGN KEY ("automation_rule_id") REFERENCES "public"."automation_rules"("id") ON DELETE set null ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "programs" ADD CONSTRAINT "programs_updated_by_users_id_fk" FOREIGN KEY ("updated_by") REFERENCES "public"."users"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
CREATE INDEX "program_enrollments_tenant_id_user_id_status_index" ON "program_enrollments" USING btree ("tenant_id","user_id","status");--> statement-breakpoint
CREATE INDEX "program_nodes_tenant_id_program_id_sort_index" ON "program_nodes" USING btree ("tenant_id","program_id","sort");--> statement-breakpoint
CREATE INDEX "programs_tenant_id_status_index" ON "programs" USING btree ("tenant_id","status");DO $$
DECLARE t text;
BEGIN
  FOREACH t IN ARRAY ARRAY['programs', 'program_nodes', 'program_edges', 'program_enrollments']
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
UPDATE roles SET scopes = array_cat(scopes, ARRAY['program.manage','program.publish']) WHERE is_system AND code = 'author' AND NOT scopes @> ARRAY['program.manage'];
--> statement-breakpoint
UPDATE roles SET scopes = array_cat(scopes, ARRAY['program.manage','program.publish','program.link_rule']) WHERE is_system AND code = 'admin' AND NOT scopes @> ARRAY['program.manage'];
