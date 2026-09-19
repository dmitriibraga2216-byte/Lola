CREATE TABLE "assessment_answers" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	"updated_at" timestamp with time zone DEFAULT now() NOT NULL,
	"tenant_id" uuid NOT NULL,
	"task_id" uuid NOT NULL,
	"criterion_id" uuid NOT NULL,
	"value" numeric(6, 2),
	"comment" text,
	"is_na" boolean DEFAULT false NOT NULL,
	CONSTRAINT "assessment_answers_task_id_criterion_id_unique" UNIQUE("task_id","criterion_id")
);
--> statement-breakpoint
CREATE TABLE "assessment_cycles" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	"updated_at" timestamp with time zone DEFAULT now() NOT NULL,
	"tenant_id" uuid NOT NULL,
	"title" text NOT NULL,
	"form_id" uuid NOT NULL,
	"period_from" date NOT NULL,
	"period_to" date NOT NULL,
	"starts_at" timestamp with time zone NOT NULL,
	"ends_at" timestamp with time zone NOT NULL,
	"subjects" jsonb NOT NULL,
	"rater_kinds" text[] NOT NULL,
	"peers_count" integer,
	"peers_selection" text DEFAULT 'auto',
	"anonymous_for_subject" boolean DEFAULT true NOT NULL,
	"min_raters_to_show" integer DEFAULT 3 NOT NULL,
	"self_first" boolean DEFAULT false NOT NULL,
	"calibration" boolean DEFAULT false NOT NULL,
	"status" text DEFAULT 'draft' NOT NULL,
	"created_by" uuid,
	"finished_at" timestamp with time zone
);
--> statement-breakpoint
CREATE TABLE "assessment_forms" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	"updated_at" timestamp with time zone DEFAULT now() NOT NULL,
	"tenant_id" uuid NOT NULL,
	"title" text NOT NULL,
	"description" text,
	"group_ids" uuid[] DEFAULT '{}'::uuid[] NOT NULL,
	"is_active" boolean DEFAULT true NOT NULL
);
--> statement-breakpoint
CREATE TABLE "assessment_tasks" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	"updated_at" timestamp with time zone DEFAULT now() NOT NULL,
	"tenant_id" uuid NOT NULL,
	"cycle_id" uuid NOT NULL,
	"subject_user_id" uuid NOT NULL,
	"rater_user_id" uuid NOT NULL,
	"rater_kind" text NOT NULL,
	"status" text DEFAULT 'pending' NOT NULL,
	"due_at" timestamp with time zone NOT NULL,
	"submitted_at" timestamp with time zone,
	"decline_reason" text,
	CONSTRAINT "assessment_tasks_cycle_id_subject_user_id_rater_user_id_unique" UNIQUE("cycle_id","subject_user_id","rater_user_id")
);
--> statement-breakpoint
CREATE TABLE "checklist_runs" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	"updated_at" timestamp with time zone DEFAULT now() NOT NULL,
	"tenant_id" uuid NOT NULL,
	"checklist_id" uuid NOT NULL,
	"subject_kind" text NOT NULL,
	"location_id" uuid,
	"subject_user_id" uuid,
	"observer_id" uuid NOT NULL,
	"status" text DEFAULT 'draft' NOT NULL,
	"started_at" timestamp with time zone DEFAULT now() NOT NULL,
	"finished_at" timestamp with time zone,
	"answers" jsonb DEFAULT '[]' NOT NULL,
	"score" numeric(6, 2),
	"passed" boolean,
	"critical_failed" jsonb DEFAULT '[]' NOT NULL,
	"action_plan" jsonb DEFAULT '[]' NOT NULL,
	"signature_media_id" uuid,
	"geo" jsonb,
	"device" text
);
--> statement-breakpoint
CREATE TABLE "checklists" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	"updated_at" timestamp with time zone DEFAULT now() NOT NULL,
	"tenant_id" uuid NOT NULL,
	"title" text NOT NULL,
	"kind" text DEFAULT 'observation' NOT NULL,
	"items" jsonb NOT NULL,
	"scoring" text DEFAULT 'percent' NOT NULL,
	"pass_score" numeric(6, 2) DEFAULT '80' NOT NULL,
	"critical_fail_rule" text DEFAULT 'any_critical_fails_all' NOT NULL,
	"who_can_run" jsonb DEFAULT '{"roles":["mentor","manager","admin"]}' NOT NULL,
	"subject_kind" text DEFAULT 'location' NOT NULL,
	"frequency" jsonb,
	"require_signature" boolean DEFAULT false NOT NULL,
	"is_active" boolean DEFAULT true NOT NULL,
	"created_by" uuid
);
--> statement-breakpoint
CREATE TABLE "criteria" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	"updated_at" timestamp with time zone DEFAULT now() NOT NULL,
	"tenant_id" uuid NOT NULL,
	"group_id" uuid NOT NULL,
	"text" text NOT NULL,
	"description" text,
	"scale_id" uuid NOT NULL,
	"weight" numeric(6, 2) DEFAULT '1' NOT NULL,
	"is_critical" boolean DEFAULT false NOT NULL,
	"requires_comment_below" numeric(6, 2),
	"competency_id" uuid,
	"requires_photo" boolean DEFAULT false NOT NULL,
	"sort" integer DEFAULT 0 NOT NULL
);
--> statement-breakpoint
CREATE TABLE "criteria_groups" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	"updated_at" timestamp with time zone DEFAULT now() NOT NULL,
	"tenant_id" uuid NOT NULL,
	"name" text NOT NULL,
	"description" text,
	"sort" integer DEFAULT 0 NOT NULL,
	"weight" numeric(6, 2) DEFAULT '1' NOT NULL
);
--> statement-breakpoint
CREATE TABLE "rating_scales" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	"updated_at" timestamp with time zone DEFAULT now() NOT NULL,
	"tenant_id" uuid NOT NULL,
	"name" text NOT NULL,
	"kind" text DEFAULT 'ordinal' NOT NULL,
	"options" jsonb NOT NULL,
	"pass_threshold" numeric(6, 2),
	"allow_na" boolean DEFAULT true NOT NULL,
	CONSTRAINT "rating_scales_tenant_id_name_unique" UNIQUE("tenant_id","name")
);
--> statement-breakpoint
ALTER TABLE "assessment_answers" ADD CONSTRAINT "assessment_answers_task_id_assessment_tasks_id_fk" FOREIGN KEY ("task_id") REFERENCES "public"."assessment_tasks"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "assessment_answers" ADD CONSTRAINT "assessment_answers_criterion_id_criteria_id_fk" FOREIGN KEY ("criterion_id") REFERENCES "public"."criteria"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "assessment_cycles" ADD CONSTRAINT "assessment_cycles_form_id_assessment_forms_id_fk" FOREIGN KEY ("form_id") REFERENCES "public"."assessment_forms"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "assessment_cycles" ADD CONSTRAINT "assessment_cycles_created_by_users_id_fk" FOREIGN KEY ("created_by") REFERENCES "public"."users"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "assessment_tasks" ADD CONSTRAINT "assessment_tasks_cycle_id_assessment_cycles_id_fk" FOREIGN KEY ("cycle_id") REFERENCES "public"."assessment_cycles"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "assessment_tasks" ADD CONSTRAINT "assessment_tasks_subject_user_id_users_id_fk" FOREIGN KEY ("subject_user_id") REFERENCES "public"."users"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "assessment_tasks" ADD CONSTRAINT "assessment_tasks_rater_user_id_users_id_fk" FOREIGN KEY ("rater_user_id") REFERENCES "public"."users"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "checklist_runs" ADD CONSTRAINT "checklist_runs_checklist_id_checklists_id_fk" FOREIGN KEY ("checklist_id") REFERENCES "public"."checklists"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "checklist_runs" ADD CONSTRAINT "checklist_runs_location_id_locations_id_fk" FOREIGN KEY ("location_id") REFERENCES "public"."locations"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "checklist_runs" ADD CONSTRAINT "checklist_runs_subject_user_id_users_id_fk" FOREIGN KEY ("subject_user_id") REFERENCES "public"."users"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "checklist_runs" ADD CONSTRAINT "checklist_runs_observer_id_users_id_fk" FOREIGN KEY ("observer_id") REFERENCES "public"."users"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "checklists" ADD CONSTRAINT "checklists_created_by_users_id_fk" FOREIGN KEY ("created_by") REFERENCES "public"."users"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "criteria" ADD CONSTRAINT "criteria_group_id_criteria_groups_id_fk" FOREIGN KEY ("group_id") REFERENCES "public"."criteria_groups"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "criteria" ADD CONSTRAINT "criteria_scale_id_rating_scales_id_fk" FOREIGN KEY ("scale_id") REFERENCES "public"."rating_scales"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "criteria" ADD CONSTRAINT "criteria_competency_id_competencies_id_fk" FOREIGN KEY ("competency_id") REFERENCES "public"."competencies"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
CREATE INDEX "assessment_cycles_tenant_id_status_index" ON "assessment_cycles" USING btree ("tenant_id","status");--> statement-breakpoint
CREATE INDEX "assessment_tasks_tenant_id_rater_user_id_status_index" ON "assessment_tasks" USING btree ("tenant_id","rater_user_id","status");--> statement-breakpoint
CREATE INDEX "assessment_tasks_tenant_id_subject_user_id_index" ON "assessment_tasks" USING btree ("tenant_id","subject_user_id");--> statement-breakpoint
CREATE INDEX "checklist_runs_tenant_id_checklist_id_started_at_index" ON "checklist_runs" USING btree ("tenant_id","checklist_id","started_at" DESC NULLS LAST);--> statement-breakpoint
CREATE INDEX "checklist_runs_tenant_id_location_id_index" ON "checklist_runs" USING btree ("tenant_id","location_id");--> statement-breakpoint
CREATE INDEX "checklist_runs_tenant_id_observer_id_status_index" ON "checklist_runs" USING btree ("tenant_id","observer_id","status");--> statement-breakpoint
CREATE INDEX "criteria_tenant_id_group_id_index" ON "criteria" USING btree ("tenant_id","group_id");DO $$
DECLARE t text;
BEGIN
  FOREACH t IN ARRAY ARRAY[
    'rating_scales', 'criteria_groups', 'criteria', 'assessment_forms', 'assessment_cycles',
    'assessment_tasks', 'assessment_answers', 'checklists', 'checklist_runs'
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
-- Скоупы оценки (docs/20 §2) системным ролям
UPDATE roles SET scopes = array_cat(scopes, ARRAY['assessment.own']) WHERE is_system AND code = 'employee' AND NOT scopes @> ARRAY['assessment.own'];
--> statement-breakpoint
UPDATE roles SET scopes = array_cat(scopes, ARRAY['assessment.own','checklist.run']) WHERE is_system AND code = 'mentor' AND NOT scopes @> ARRAY['checklist.run'];
--> statement-breakpoint
UPDATE roles SET scopes = array_cat(scopes, ARRAY['assessment.own','assessment.team','assessment.run','checklist.run']) WHERE is_system AND code = 'manager' AND NOT scopes @> ARRAY['assessment.team'];
--> statement-breakpoint
UPDATE roles SET scopes = array_cat(scopes, ARRAY['assessment.own','assessment.run','assessment.manage','checklist.manage']) WHERE is_system AND code = 'author' AND NOT scopes @> ARRAY['assessment.manage'];
--> statement-breakpoint
UPDATE roles SET scopes = array_cat(scopes, ARRAY['assessment.own','assessment.team','assessment.run','assessment.manage','checklist.run','checklist.manage']) WHERE is_system AND code = 'admin' AND NOT scopes @> ARRAY['assessment.manage'];
--> statement-breakpoint
-- Шкалы по умолчанию (docs/20 §3.1) каждому тенанту
INSERT INTO rating_scales (tenant_id, name, kind, options, pass_threshold, allow_na)
SELECT t.id, s.name, s.kind, s.options::jsonb, s.pass, s.na FROM tenants t CROSS JOIN (VALUES
  ('Зараховано / Не зараховано', 'binary', '[{"value":0,"label":"Не зараховано","color":"coral"},{"value":1,"label":"Зараховано","color":"teal"}]', 1, true),
  ('1–5', 'ordinal', '[{"value":1,"label":"Не відповідає","color":"coral"},{"value":2,"label":"Частково","color":"coral"},{"value":3,"label":"Відповідає","color":"sun"},{"value":4,"label":"Вище очікувань","color":"teal"},{"value":5,"label":"Взірець","color":"teal"}]', 3, true)
) AS s(name, kind, options, pass, na)
ON CONFLICT DO NOTHING;
