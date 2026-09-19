CREATE TABLE "career_requests" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	"updated_at" timestamp with time zone DEFAULT now() NOT NULL,
	"tenant_id" uuid NOT NULL,
	"user_id" uuid NOT NULL,
	"target_position_id" uuid NOT NULL,
	"target_location_id" uuid,
	"motivation" text,
	"status" text DEFAULT 'new' NOT NULL,
	"approvals" jsonb DEFAULT '[]' NOT NULL,
	"assessment_id" uuid,
	"decided_at" timestamp with time zone
);
--> statement-breakpoint
CREATE TABLE "competencies" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	"updated_at" timestamp with time zone DEFAULT now() NOT NULL,
	"tenant_id" uuid NOT NULL,
	"name" text NOT NULL,
	"category_id" uuid,
	"description" text,
	"kind" text DEFAULT 'hard' NOT NULL,
	"levels" jsonb NOT NULL,
	"linked_courses" uuid[] DEFAULT '{}'::uuid[] NOT NULL,
	"linked_knowledge" uuid[] DEFAULT '{}'::uuid[] NOT NULL,
	"is_active" boolean DEFAULT true NOT NULL,
	CONSTRAINT "competencies_tenant_id_name_unique" UNIQUE("tenant_id","name")
);
--> statement-breakpoint
CREATE TABLE "competency_assessments" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	"updated_at" timestamp with time zone DEFAULT now() NOT NULL,
	"tenant_id" uuid NOT NULL,
	"user_id" uuid NOT NULL,
	"competency_id" uuid NOT NULL,
	"level" integer NOT NULL,
	"source" text NOT NULL,
	"evidence_id" uuid,
	"assessed_by" uuid,
	"assessed_at" timestamp with time zone DEFAULT now() NOT NULL,
	"valid_until" timestamp with time zone,
	"comment" text
);
--> statement-breakpoint
CREATE TABLE "development_goals" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	"updated_at" timestamp with time zone DEFAULT now() NOT NULL,
	"tenant_id" uuid NOT NULL,
	"plan_id" uuid,
	"user_id" uuid NOT NULL,
	"title" text NOT NULL,
	"description" text,
	"kind" text DEFAULT 'learning' NOT NULL,
	"competency_id" uuid,
	"target_level" integer,
	"metric" text,
	"linked_content" jsonb DEFAULT '[]' NOT NULL,
	"due_at" date NOT NULL,
	"status_code" text NOT NULL,
	"progress_pct" integer DEFAULT 0 NOT NULL,
	"mentor_id" uuid,
	"result" text,
	"evaluated_by" uuid,
	"evaluated_at" timestamp with time zone,
	"evaluation" text,
	"created_by" uuid
);
--> statement-breakpoint
CREATE TABLE "development_plans" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	"updated_at" timestamp with time zone DEFAULT now() NOT NULL,
	"tenant_id" uuid NOT NULL,
	"user_id" uuid NOT NULL,
	"period_from" date NOT NULL,
	"period_to" date NOT NULL,
	"owner_id" uuid,
	"status" text DEFAULT 'draft' NOT NULL,
	"summary" text,
	"created_by" uuid,
	"approved_by" uuid,
	"approved_at" timestamp with time zone,
	"closed_at" timestamp with time zone,
	"result_comment" text
);
--> statement-breakpoint
CREATE TABLE "external_training_requests" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	"updated_at" timestamp with time zone DEFAULT now() NOT NULL,
	"tenant_id" uuid NOT NULL,
	"user_id" uuid NOT NULL,
	"title" text NOT NULL,
	"provider" text,
	"format" text DEFAULT 'online' NOT NULL,
	"starts_at" date,
	"cost" numeric(12, 2),
	"currency" text DEFAULT 'UAH' NOT NULL,
	"justification" text,
	"expected_result" text,
	"status" text DEFAULT 'new' NOT NULL,
	"approvals" jsonb DEFAULT '[]' NOT NULL,
	"report" text,
	"documents" jsonb DEFAULT '[]' NOT NULL,
	"decided_at" timestamp with time zone
);
--> statement-breakpoint
CREATE TABLE "goal_comments" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	"updated_at" timestamp with time zone DEFAULT now() NOT NULL,
	"tenant_id" uuid NOT NULL,
	"goal_id" uuid NOT NULL,
	"author_id" uuid NOT NULL,
	"body" text NOT NULL
);
--> statement-breakpoint
CREATE TABLE "goal_status_log" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	"updated_at" timestamp with time zone DEFAULT now() NOT NULL,
	"tenant_id" uuid NOT NULL,
	"goal_id" uuid NOT NULL,
	"from_status" text,
	"to_status" text NOT NULL,
	"actor_id" uuid,
	"comment" text
);
--> statement-breakpoint
CREATE TABLE "goal_statuses" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	"updated_at" timestamp with time zone DEFAULT now() NOT NULL,
	"tenant_id" uuid NOT NULL,
	"code" text NOT NULL,
	"name" text NOT NULL,
	"color" text DEFAULT 'muted' NOT NULL,
	"sort" integer DEFAULT 0 NOT NULL,
	"is_initial" boolean DEFAULT false NOT NULL,
	"is_final" boolean DEFAULT false NOT NULL,
	"is_success" boolean DEFAULT false NOT NULL,
	"requires_comment" boolean DEFAULT false NOT NULL,
	"allowed_transitions" text[] DEFAULT '{}'::text[] NOT NULL,
	"who_can_set" text[] DEFAULT '{development.own,development.team}'::text[] NOT NULL,
	CONSTRAINT "goal_statuses_tenant_id_code_unique" UNIQUE("tenant_id","code")
);
--> statement-breakpoint
CREATE TABLE "position_profiles" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	"updated_at" timestamp with time zone DEFAULT now() NOT NULL,
	"tenant_id" uuid NOT NULL,
	"position_id" uuid NOT NULL,
	"position_level_id" uuid,
	"description" text,
	"competency_requirements" jsonb DEFAULT '[]' NOT NULL,
	"mandatory_content" jsonb DEFAULT '[]' NOT NULL,
	"probation_days" integer,
	"is_active" boolean DEFAULT true NOT NULL,
	"updated_by" uuid,
	CONSTRAINT "position_profiles_tenant_id_position_id_position_level_id_unique" UNIQUE("tenant_id","position_id","position_level_id")
);
--> statement-breakpoint
ALTER TABLE "career_requests" ADD CONSTRAINT "career_requests_user_id_users_id_fk" FOREIGN KEY ("user_id") REFERENCES "public"."users"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "career_requests" ADD CONSTRAINT "career_requests_target_position_id_positions_id_fk" FOREIGN KEY ("target_position_id") REFERENCES "public"."positions"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "competencies" ADD CONSTRAINT "competencies_category_id_course_categories_id_fk" FOREIGN KEY ("category_id") REFERENCES "public"."course_categories"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "competency_assessments" ADD CONSTRAINT "competency_assessments_user_id_users_id_fk" FOREIGN KEY ("user_id") REFERENCES "public"."users"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "competency_assessments" ADD CONSTRAINT "competency_assessments_competency_id_competencies_id_fk" FOREIGN KEY ("competency_id") REFERENCES "public"."competencies"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "competency_assessments" ADD CONSTRAINT "competency_assessments_assessed_by_users_id_fk" FOREIGN KEY ("assessed_by") REFERENCES "public"."users"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "development_goals" ADD CONSTRAINT "development_goals_plan_id_development_plans_id_fk" FOREIGN KEY ("plan_id") REFERENCES "public"."development_plans"("id") ON DELETE set null ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "development_goals" ADD CONSTRAINT "development_goals_user_id_users_id_fk" FOREIGN KEY ("user_id") REFERENCES "public"."users"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "development_goals" ADD CONSTRAINT "development_goals_competency_id_competencies_id_fk" FOREIGN KEY ("competency_id") REFERENCES "public"."competencies"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "development_goals" ADD CONSTRAINT "development_goals_mentor_id_users_id_fk" FOREIGN KEY ("mentor_id") REFERENCES "public"."users"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "development_goals" ADD CONSTRAINT "development_goals_evaluated_by_users_id_fk" FOREIGN KEY ("evaluated_by") REFERENCES "public"."users"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "development_goals" ADD CONSTRAINT "development_goals_created_by_users_id_fk" FOREIGN KEY ("created_by") REFERENCES "public"."users"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "development_plans" ADD CONSTRAINT "development_plans_user_id_users_id_fk" FOREIGN KEY ("user_id") REFERENCES "public"."users"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "development_plans" ADD CONSTRAINT "development_plans_owner_id_users_id_fk" FOREIGN KEY ("owner_id") REFERENCES "public"."users"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "development_plans" ADD CONSTRAINT "development_plans_created_by_users_id_fk" FOREIGN KEY ("created_by") REFERENCES "public"."users"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "development_plans" ADD CONSTRAINT "development_plans_approved_by_users_id_fk" FOREIGN KEY ("approved_by") REFERENCES "public"."users"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "external_training_requests" ADD CONSTRAINT "external_training_requests_user_id_users_id_fk" FOREIGN KEY ("user_id") REFERENCES "public"."users"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "goal_comments" ADD CONSTRAINT "goal_comments_goal_id_development_goals_id_fk" FOREIGN KEY ("goal_id") REFERENCES "public"."development_goals"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "goal_comments" ADD CONSTRAINT "goal_comments_author_id_users_id_fk" FOREIGN KEY ("author_id") REFERENCES "public"."users"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "goal_status_log" ADD CONSTRAINT "goal_status_log_goal_id_development_goals_id_fk" FOREIGN KEY ("goal_id") REFERENCES "public"."development_goals"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "goal_status_log" ADD CONSTRAINT "goal_status_log_actor_id_users_id_fk" FOREIGN KEY ("actor_id") REFERENCES "public"."users"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "position_profiles" ADD CONSTRAINT "position_profiles_position_id_positions_id_fk" FOREIGN KEY ("position_id") REFERENCES "public"."positions"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "position_profiles" ADD CONSTRAINT "position_profiles_position_level_id_position_levels_id_fk" FOREIGN KEY ("position_level_id") REFERENCES "public"."position_levels"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "position_profiles" ADD CONSTRAINT "position_profiles_updated_by_users_id_fk" FOREIGN KEY ("updated_by") REFERENCES "public"."users"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
CREATE INDEX "competency_assessments_tenant_id_user_id_competency_id_assessed_at_index" ON "competency_assessments" USING btree ("tenant_id","user_id","competency_id","assessed_at" DESC NULLS LAST);--> statement-breakpoint
CREATE INDEX "development_goals_tenant_id_user_id_status_code_index" ON "development_goals" USING btree ("tenant_id","user_id","status_code");--> statement-breakpoint
CREATE INDEX "development_goals_tenant_id_due_at_index" ON "development_goals" USING btree ("tenant_id","due_at");--> statement-breakpoint
CREATE INDEX "development_plans_tenant_id_user_id_status_index" ON "development_plans" USING btree ("tenant_id","user_id","status");--> statement-breakpoint
CREATE INDEX "external_training_requests_tenant_id_status_index" ON "external_training_requests" USING btree ("tenant_id","status");--> statement-breakpoint
DO $$
DECLARE t text;
BEGIN
  FOREACH t IN ARRAY ARRAY[
    'competencies', 'position_profiles', 'competency_assessments', 'development_plans', 'goal_statuses',
    'development_goals', 'goal_status_log', 'goal_comments', 'external_training_requests', 'career_requests'
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
-- Новые скоупы развития (docs/19 §2) существующим системным ролям
UPDATE roles SET scopes = array_cat(scopes, ARRAY['development.own']) WHERE is_system AND code = 'employee' AND NOT scopes @> ARRAY['development.own'];
--> statement-breakpoint
UPDATE roles SET scopes = array_cat(scopes, ARRAY['development.own','development.team']) WHERE is_system AND code = 'mentor' AND NOT scopes @> ARRAY['development.team'];
--> statement-breakpoint
UPDATE roles SET scopes = array_cat(scopes, ARRAY['development.own','development.team','request.decide']) WHERE is_system AND code = 'manager' AND NOT scopes @> ARRAY['development.team'];
--> statement-breakpoint
UPDATE roles SET scopes = array_cat(scopes, ARRAY['development.own','development.team','development.manage','competency.manage','position_profile.manage']) WHERE is_system AND code = 'author' AND NOT scopes @> ARRAY['development.manage'];
--> statement-breakpoint
UPDATE roles SET scopes = array_cat(scopes, ARRAY['development.own','development.team','development.manage','competency.manage','position_profile.manage','request.decide']) WHERE is_system AND code = 'admin' AND NOT scopes @> ARRAY['development.manage'];
--> statement-breakpoint
-- Статусы целей по умолчанию (docs/19 §4) для каждого тенанта
INSERT INTO goal_statuses (tenant_id, code, name, color, sort, is_initial, is_final, is_success, requires_comment, allowed_transitions, who_can_set)
SELECT t.id, s.code, s.name, s.color, s.sort, s.is_initial, s.is_final, s.is_success, s.requires_comment, s.transitions, s.who
FROM tenants t CROSS JOIN (VALUES
  ('planned',     'Заплановано',   'muted', 0, true,  false, false, false, ARRAY['in_progress','cancelled'],                 ARRAY['development.own','development.team']),
  ('in_progress', 'В роботі',      'sun',   1, false, false, false, false, ARRAY['on_review','cancelled'],                   ARRAY['development.own','development.team']),
  ('on_review',   'На перевірці',  'sun',   2, false, false, false, false, ARRAY['achieved','not_achieved','in_progress'],   ARRAY['development.own']),
  ('achieved',    'Досягнуто',     'teal',  3, false, true,  true,  false, ARRAY[]::text[],                                  ARRAY['development.team']),
  ('not_achieved','Не досягнуто',  'coral', 4, false, true,  false, true,  ARRAY['in_progress'],                             ARRAY['development.team']),
  ('cancelled',   'Скасовано',     'muted', 5, false, true,  false, true,  ARRAY[]::text[],                                  ARRAY['development.own','development.team'])
) AS s(code, name, color, sort, is_initial, is_final, is_success, requires_comment, transitions, who)
ON CONFLICT (tenant_id, code) DO NOTHING;
