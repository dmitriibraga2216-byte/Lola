CREATE TABLE "automation_rule_dimensions" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	"updated_at" timestamp with time zone DEFAULT now() NOT NULL,
	"tenant_id" uuid NOT NULL,
	"rule_id" uuid NOT NULL,
	"dimension" text NOT NULL,
	"mode" text DEFAULT 'any' NOT NULL,
	"value_ids" uuid[] DEFAULT '{}'::uuid[] NOT NULL,
	CONSTRAINT "automation_rule_dimensions_rule_id_dimension_unique" UNIQUE("rule_id","dimension")
);
--> statement-breakpoint
CREATE TABLE "trajectories" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	"updated_at" timestamp with time zone DEFAULT now() NOT NULL,
	"tenant_id" uuid NOT NULL,
	"title" text NOT NULL,
	"description" text,
	"cover_key" text,
	"status" text DEFAULT 'draft' NOT NULL,
	"tags" text[] DEFAULT '{}'::text[] NOT NULL,
	"assign_mode" text DEFAULT 'manual' NOT NULL,
	"automation_rule_id" uuid,
	"stop_assign_after_finish" boolean DEFAULT false NOT NULL,
	"published_at" timestamp with time zone,
	"created_by" uuid,
	"updated_by" uuid
);
--> statement-breakpoint
CREATE TABLE "trajectory_edges" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	"updated_at" timestamp with time zone DEFAULT now() NOT NULL,
	"tenant_id" uuid NOT NULL,
	"trajectory_id" uuid NOT NULL,
	"from_node_id" uuid NOT NULL,
	"to_node_id" uuid NOT NULL,
	"condition" jsonb,
	"sort" integer DEFAULT 0 NOT NULL,
	CONSTRAINT "trajectory_edges_from_node_id_to_node_id_unique" UNIQUE("from_node_id","to_node_id")
);
--> statement-breakpoint
CREATE TABLE "trajectory_enrollments" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	"updated_at" timestamp with time zone DEFAULT now() NOT NULL,
	"tenant_id" uuid NOT NULL,
	"trajectory_id" uuid NOT NULL,
	"user_id" uuid NOT NULL,
	"status" text DEFAULT 'not_started' NOT NULL,
	"source" text DEFAULT 'manual' NOT NULL,
	"rule_id" uuid,
	"mentor_id" uuid,
	"requested_at" timestamp with time zone,
	"available_from" timestamp with time zone,
	"started_at" timestamp with time zone,
	"completed_at" timestamp with time zone,
	"cancelled_at" timestamp with time zone,
	"cancel_reason" text,
	"progress_pct" numeric(5, 2) DEFAULT '0' NOT NULL,
	"last_activity_at" timestamp with time zone,
	CONSTRAINT "trajectory_enrollments_trajectory_id_user_id_unique" UNIQUE("trajectory_id","user_id")
);
--> statement-breakpoint
CREATE TABLE "trajectory_node_states" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	"updated_at" timestamp with time zone DEFAULT now() NOT NULL,
	"tenant_id" uuid NOT NULL,
	"enrollment_id" uuid NOT NULL,
	"node_id" uuid NOT NULL,
	"status" text DEFAULT 'locked' NOT NULL,
	"activated_at" timestamp with time zone,
	"finished_at" timestamp with time zone,
	"fires_at" timestamp with time zone,
	"score" numeric(5, 2),
	"passed" boolean,
	"assignment_id" uuid,
	"reason" text,
	"chosen_edge_id" uuid,
	CONSTRAINT "trajectory_node_states_enrollment_id_node_id_unique" UNIQUE("enrollment_id","node_id")
);
--> statement-breakpoint
CREATE TABLE "trajectory_nodes" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	"updated_at" timestamp with time zone DEFAULT now() NOT NULL,
	"tenant_id" uuid NOT NULL,
	"trajectory_id" uuid NOT NULL,
	"kind" text NOT NULL,
	"title" text,
	"content_type" text,
	"content_id" uuid,
	"days" integer,
	"mentor_id" uuid,
	"params" jsonb DEFAULT '{}'::jsonb NOT NULL,
	"x" integer DEFAULT 0 NOT NULL,
	"y" integer DEFAULT 0 NOT NULL
);
--> statement-breakpoint
ALTER TABLE "automation_rule_dimensions" ADD CONSTRAINT "automation_rule_dimensions_rule_id_automation_rules_id_fk" FOREIGN KEY ("rule_id") REFERENCES "public"."automation_rules"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "trajectories" ADD CONSTRAINT "trajectories_automation_rule_id_automation_rules_id_fk" FOREIGN KEY ("automation_rule_id") REFERENCES "public"."automation_rules"("id") ON DELETE set null ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "trajectories" ADD CONSTRAINT "trajectories_created_by_users_id_fk" FOREIGN KEY ("created_by") REFERENCES "public"."users"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "trajectories" ADD CONSTRAINT "trajectories_updated_by_users_id_fk" FOREIGN KEY ("updated_by") REFERENCES "public"."users"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "trajectory_edges" ADD CONSTRAINT "trajectory_edges_trajectory_id_trajectories_id_fk" FOREIGN KEY ("trajectory_id") REFERENCES "public"."trajectories"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "trajectory_edges" ADD CONSTRAINT "trajectory_edges_from_node_id_trajectory_nodes_id_fk" FOREIGN KEY ("from_node_id") REFERENCES "public"."trajectory_nodes"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "trajectory_edges" ADD CONSTRAINT "trajectory_edges_to_node_id_trajectory_nodes_id_fk" FOREIGN KEY ("to_node_id") REFERENCES "public"."trajectory_nodes"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "trajectory_enrollments" ADD CONSTRAINT "trajectory_enrollments_trajectory_id_trajectories_id_fk" FOREIGN KEY ("trajectory_id") REFERENCES "public"."trajectories"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "trajectory_enrollments" ADD CONSTRAINT "trajectory_enrollments_user_id_users_id_fk" FOREIGN KEY ("user_id") REFERENCES "public"."users"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "trajectory_enrollments" ADD CONSTRAINT "trajectory_enrollments_mentor_id_users_id_fk" FOREIGN KEY ("mentor_id") REFERENCES "public"."users"("id") ON DELETE set null ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "trajectory_node_states" ADD CONSTRAINT "trajectory_node_states_enrollment_id_trajectory_enrollments_id_fk" FOREIGN KEY ("enrollment_id") REFERENCES "public"."trajectory_enrollments"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "trajectory_node_states" ADD CONSTRAINT "trajectory_node_states_node_id_trajectory_nodes_id_fk" FOREIGN KEY ("node_id") REFERENCES "public"."trajectory_nodes"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "trajectory_nodes" ADD CONSTRAINT "trajectory_nodes_trajectory_id_trajectories_id_fk" FOREIGN KEY ("trajectory_id") REFERENCES "public"."trajectories"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "trajectory_nodes" ADD CONSTRAINT "trajectory_nodes_mentor_id_users_id_fk" FOREIGN KEY ("mentor_id") REFERENCES "public"."users"("id") ON DELETE set null ON UPDATE no action;--> statement-breakpoint
CREATE INDEX "automation_rule_dimensions_tenant_id_rule_id_index" ON "automation_rule_dimensions" USING btree ("tenant_id","rule_id");--> statement-breakpoint
CREATE INDEX "trajectories_tenant_id_status_index" ON "trajectories" USING btree ("tenant_id","status");--> statement-breakpoint
CREATE INDEX "trajectory_edges_tenant_id_trajectory_id_index" ON "trajectory_edges" USING btree ("tenant_id","trajectory_id");--> statement-breakpoint
CREATE INDEX "trajectory_enrollments_tenant_id_user_id_status_index" ON "trajectory_enrollments" USING btree ("tenant_id","user_id","status");--> statement-breakpoint
CREATE INDEX "trajectory_node_states_tenant_id_enrollment_id_index" ON "trajectory_node_states" USING btree ("tenant_id","enrollment_id");--> statement-breakpoint
CREATE INDEX "trajectory_nodes_tenant_id_trajectory_id_index" ON "trajectory_nodes" USING btree ("tenant_id","trajectory_id");--> statement-breakpoint
-- Перечисления docs/02 под CHECK (CLAUDE.md п. 13)
ALTER TABLE "trajectories" ADD CONSTRAINT "trajectories_assign_mode_assign_mode" CHECK ("assign_mode" IN ('manual', 'catalog_free', 'catalog_request', 'automation'));--> statement-breakpoint
ALTER TABLE "trajectories" ADD CONSTRAINT "trajectories_status_check" CHECK ("status" IN ('draft', 'published', 'archived'));--> statement-breakpoint
ALTER TABLE "trajectory_nodes" ADD CONSTRAINT "trajectory_nodes_kind_trajectory_node_kind" CHECK ("kind" IN ('start', 'finish', 'task', 'and', 'or', 'delay', 'stop_delay', 'branch', 'mentor'));--> statement-breakpoint
ALTER TABLE "trajectory_nodes" ADD CONSTRAINT "trajectory_nodes_content_type_content_type" CHECK ("content_type" IS NULL OR "content_type" IN ('course', 'training_program', 'resource', 'test', 'complex_test', 'workshop', 'poll', 'assessment', 'check_list', 'meetup', 'webinar'));--> statement-breakpoint
ALTER TABLE "trajectory_enrollments" ADD CONSTRAINT "trajectory_enrollments_status_enrollment_status" CHECK ("status" IN ('not_assigned', 'not_started', 'in_progress', 'done', 'failed'));--> statement-breakpoint
ALTER TABLE "trajectory_node_states" ADD CONSTRAINT "trajectory_node_states_status_check" CHECK ("status" IN ('locked', 'available', 'in_progress', 'done', 'failed', 'skipped'));--> statement-breakpoint
ALTER TABLE "automation_rule_dimensions" ADD CONSTRAINT "automation_rule_dimensions_dimension_check" CHECK ("dimension" IN ('city', 'position', 'org_unit', 'tag'));--> statement-breakpoint
ALTER TABLE "automation_rule_dimensions" ADD CONSTRAINT "automation_rule_dimensions_mode_check" CHECK ("mode" IN ('any', 'include', 'exclude'));--> statement-breakpoint
-- Таблицы тенанта — RLS обязателен (CLAUDE.md п. 1)
ALTER TABLE automation_rule_dimensions ENABLE ROW LEVEL SECURITY;--> statement-breakpoint
ALTER TABLE automation_rule_dimensions FORCE ROW LEVEL SECURITY;--> statement-breakpoint
CREATE POLICY tenant_isolation ON automation_rule_dimensions
  USING (tenant_id = nullif(current_setting('app.tenant_id', true), '')::uuid)
  WITH CHECK (tenant_id = nullif(current_setting('app.tenant_id', true), '')::uuid);--> statement-breakpoint
ALTER TABLE trajectories ENABLE ROW LEVEL SECURITY;--> statement-breakpoint
ALTER TABLE trajectories FORCE ROW LEVEL SECURITY;--> statement-breakpoint
CREATE POLICY tenant_isolation ON trajectories
  USING (tenant_id = nullif(current_setting('app.tenant_id', true), '')::uuid)
  WITH CHECK (tenant_id = nullif(current_setting('app.tenant_id', true), '')::uuid);--> statement-breakpoint
ALTER TABLE trajectory_nodes ENABLE ROW LEVEL SECURITY;--> statement-breakpoint
ALTER TABLE trajectory_nodes FORCE ROW LEVEL SECURITY;--> statement-breakpoint
CREATE POLICY tenant_isolation ON trajectory_nodes
  USING (tenant_id = nullif(current_setting('app.tenant_id', true), '')::uuid)
  WITH CHECK (tenant_id = nullif(current_setting('app.tenant_id', true), '')::uuid);--> statement-breakpoint
ALTER TABLE trajectory_edges ENABLE ROW LEVEL SECURITY;--> statement-breakpoint
ALTER TABLE trajectory_edges FORCE ROW LEVEL SECURITY;--> statement-breakpoint
CREATE POLICY tenant_isolation ON trajectory_edges
  USING (tenant_id = nullif(current_setting('app.tenant_id', true), '')::uuid)
  WITH CHECK (tenant_id = nullif(current_setting('app.tenant_id', true), '')::uuid);--> statement-breakpoint
ALTER TABLE trajectory_enrollments ENABLE ROW LEVEL SECURITY;--> statement-breakpoint
ALTER TABLE trajectory_enrollments FORCE ROW LEVEL SECURITY;--> statement-breakpoint
CREATE POLICY tenant_isolation ON trajectory_enrollments
  USING (tenant_id = nullif(current_setting('app.tenant_id', true), '')::uuid)
  WITH CHECK (tenant_id = nullif(current_setting('app.tenant_id', true), '')::uuid);--> statement-breakpoint
ALTER TABLE trajectory_node_states ENABLE ROW LEVEL SECURITY;--> statement-breakpoint
ALTER TABLE trajectory_node_states FORCE ROW LEVEL SECURITY;--> statement-breakpoint
CREATE POLICY tenant_isolation ON trajectory_node_states
  USING (tenant_id = nullif(current_setting('app.tenant_id', true), '')::uuid)
  WITH CHECK (tenant_id = nullif(current_setting('app.tenant_id', true), '')::uuid);--> statement-breakpoint
-- Измерения существующих правил: из conditions jsonb в таблицу (docs/17 §14.2); метки — по имени в tags
INSERT INTO automation_rule_dimensions (tenant_id, rule_id, dimension, mode, value_ids)
SELECT r.tenant_id, r.id, d.dimension,
  CASE WHEN jsonb_typeof(r.conditions -> d.key) <> 'array' OR jsonb_array_length(r.conditions -> d.key) = 0 THEN 'any'
       WHEN coalesce((r.conditions ->> d.inv)::boolean, false) THEN 'exclude' ELSE 'include' END,
  CASE WHEN jsonb_typeof(r.conditions -> d.key) <> 'array' THEN '{}'::uuid[]
       WHEN d.dimension = 'tag' THEN coalesce((SELECT array_agg(t.id) FROM tags t WHERE t.tenant_id = r.tenant_id AND t.name IN (SELECT jsonb_array_elements_text(r.conditions -> 'tags'))), '{}'::uuid[])
       ELSE coalesce((SELECT array_agg(v::uuid) FROM jsonb_array_elements_text(r.conditions -> d.key) v), '{}'::uuid[]) END
FROM automation_rules r
CROSS JOIN (VALUES ('city', 'cityIds', 'cityInvert'), ('position', 'positionIds', 'positionInvert'), ('org_unit', 'orgUnitIds', 'orgUnitInvert'), ('tag', 'tags', 'tagInvert')) AS d(dimension, key, inv)
ON CONFLICT DO NOTHING;--> statement-breakpoint
UPDATE automation_rules SET conditions = conditions - 'cityIds' - 'cityInvert' - 'positionIds' - 'positionInvert' - 'orgUnitIds' - 'orgUnitInvert' - 'tags' - 'tagInvert';
