CREATE TABLE "complex_test_attempts" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	"updated_at" timestamp with time zone DEFAULT now() NOT NULL,
	"tenant_id" uuid NOT NULL,
	"complex_test_id" uuid NOT NULL,
	"user_id" uuid NOT NULL,
	"attempt_no" integer DEFAULT 1 NOT NULL,
	"parts_state" jsonb DEFAULT '[]' NOT NULL,
	"status" text DEFAULT 'in_progress' NOT NULL,
	"score" numeric(5, 2),
	"passed" boolean,
	"started_at" timestamp with time zone DEFAULT now() NOT NULL,
	"finished_at" timestamp with time zone,
	"expires_at" timestamp with time zone
);
--> statement-breakpoint
CREATE TABLE "complex_tests" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	"updated_at" timestamp with time zone DEFAULT now() NOT NULL,
	"tenant_id" uuid NOT NULL,
	"title" text NOT NULL,
	"parts" jsonb NOT NULL,
	"pass_score" numeric(5, 2) DEFAULT '70' NOT NULL,
	"time_limit_sec" integer,
	"sequential" boolean DEFAULT true NOT NULL,
	"attempts_allowed" integer DEFAULT 1 NOT NULL,
	"show_parts_result" boolean DEFAULT true NOT NULL,
	"is_active" boolean DEFAULT true NOT NULL,
	"created_by" uuid
);
--> statement-breakpoint
CREATE TABLE "meetup_registrations" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	"updated_at" timestamp with time zone DEFAULT now() NOT NULL,
	"tenant_id" uuid NOT NULL,
	"meetup_id" uuid NOT NULL,
	"user_id" uuid NOT NULL,
	"status" text DEFAULT 'registered' NOT NULL,
	"registered_at" timestamp with time zone DEFAULT now() NOT NULL,
	"registered_by" uuid,
	"waitlist_position" integer,
	"checked_in_at" timestamp with time zone,
	"check_in_method" text,
	"checked_in_by" uuid,
	"cancel_reason" text,
	"feedback_given" boolean DEFAULT false NOT NULL,
	"enrollment_id" uuid,
	"lesson_id" uuid,
	CONSTRAINT "meetup_registrations_meetup_id_user_id_unique" UNIQUE("meetup_id","user_id")
);
--> statement-breakpoint
CREATE TABLE "meetups" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	"updated_at" timestamp with time zone DEFAULT now() NOT NULL,
	"tenant_id" uuid NOT NULL,
	"kind" text DEFAULT 'meetup' NOT NULL,
	"title" text NOT NULL,
	"description" jsonb DEFAULT '[]' NOT NULL,
	"course_id" uuid,
	"starts_at" timestamp with time zone NOT NULL,
	"ends_at" timestamp with time zone NOT NULL,
	"timezone" text DEFAULT 'Europe/Kyiv' NOT NULL,
	"location_id" uuid,
	"room" text,
	"address" text,
	"trainer_ids" uuid[] DEFAULT '{}'::uuid[] NOT NULL,
	"capacity" integer,
	"waitlist_enabled" boolean DEFAULT true NOT NULL,
	"enroll_deadline_hours" integer DEFAULT 2 NOT NULL,
	"cancel_deadline_hours" integer DEFAULT 24 NOT NULL,
	"attendance_mode" text DEFAULT 'manual' NOT NULL,
	"qr_secret" text NOT NULL,
	"requires_feedback" boolean DEFAULT true NOT NULL,
	"feedback_survey_id" uuid,
	"materials" uuid[] DEFAULT '{}'::uuid[] NOT NULL,
	"status" text DEFAULT 'planned' NOT NULL,
	"cancel_reason" text,
	"created_by" uuid
);
--> statement-breakpoint
CREATE TABLE "webinar_participations" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	"updated_at" timestamp with time zone DEFAULT now() NOT NULL,
	"tenant_id" uuid NOT NULL,
	"webinar_id" uuid NOT NULL,
	"user_id" uuid NOT NULL,
	"joined_at" timestamp with time zone,
	"left_at" timestamp with time zone,
	"minutes" integer DEFAULT 0 NOT NULL,
	"attended" boolean DEFAULT false NOT NULL,
	"source" text DEFAULT 'manual' NOT NULL,
	CONSTRAINT "webinar_participations_webinar_id_user_id_unique" UNIQUE("webinar_id","user_id")
);
--> statement-breakpoint
CREATE TABLE "webinars" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	"updated_at" timestamp with time zone DEFAULT now() NOT NULL,
	"tenant_id" uuid NOT NULL,
	"meetup_id" uuid NOT NULL,
	"provider" text DEFAULT 'other' NOT NULL,
	"join_url" text,
	"host_url" text,
	"record_url" text,
	"record_available_until" timestamp with time zone,
	"auto_attendance" boolean DEFAULT false NOT NULL,
	"min_minutes_for_attendance" integer,
	CONSTRAINT "webinars_meetup_id_unique" UNIQUE("meetup_id")
);
--> statement-breakpoint
ALTER TABLE "complex_test_attempts" ADD CONSTRAINT "complex_test_attempts_complex_test_id_complex_tests_id_fk" FOREIGN KEY ("complex_test_id") REFERENCES "public"."complex_tests"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "complex_test_attempts" ADD CONSTRAINT "complex_test_attempts_user_id_users_id_fk" FOREIGN KEY ("user_id") REFERENCES "public"."users"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "complex_tests" ADD CONSTRAINT "complex_tests_created_by_users_id_fk" FOREIGN KEY ("created_by") REFERENCES "public"."users"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "meetup_registrations" ADD CONSTRAINT "meetup_registrations_meetup_id_meetups_id_fk" FOREIGN KEY ("meetup_id") REFERENCES "public"."meetups"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "meetup_registrations" ADD CONSTRAINT "meetup_registrations_user_id_users_id_fk" FOREIGN KEY ("user_id") REFERENCES "public"."users"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "meetup_registrations" ADD CONSTRAINT "meetup_registrations_registered_by_users_id_fk" FOREIGN KEY ("registered_by") REFERENCES "public"."users"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "meetup_registrations" ADD CONSTRAINT "meetup_registrations_checked_in_by_users_id_fk" FOREIGN KEY ("checked_in_by") REFERENCES "public"."users"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "meetups" ADD CONSTRAINT "meetups_course_id_courses_id_fk" FOREIGN KEY ("course_id") REFERENCES "public"."courses"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "meetups" ADD CONSTRAINT "meetups_location_id_locations_id_fk" FOREIGN KEY ("location_id") REFERENCES "public"."locations"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "meetups" ADD CONSTRAINT "meetups_feedback_survey_id_surveys_id_fk" FOREIGN KEY ("feedback_survey_id") REFERENCES "public"."surveys"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "meetups" ADD CONSTRAINT "meetups_created_by_users_id_fk" FOREIGN KEY ("created_by") REFERENCES "public"."users"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "webinar_participations" ADD CONSTRAINT "webinar_participations_webinar_id_webinars_id_fk" FOREIGN KEY ("webinar_id") REFERENCES "public"."webinars"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "webinar_participations" ADD CONSTRAINT "webinar_participations_user_id_users_id_fk" FOREIGN KEY ("user_id") REFERENCES "public"."users"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "webinars" ADD CONSTRAINT "webinars_meetup_id_meetups_id_fk" FOREIGN KEY ("meetup_id") REFERENCES "public"."meetups"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
CREATE INDEX "complex_test_attempts_tenant_id_user_id_complex_test_id_index" ON "complex_test_attempts" USING btree ("tenant_id","user_id","complex_test_id");--> statement-breakpoint
CREATE INDEX "meetup_registrations_tenant_id_user_id_status_index" ON "meetup_registrations" USING btree ("tenant_id","user_id","status");--> statement-breakpoint
CREATE INDEX "meetups_tenant_id_starts_at_index" ON "meetups" USING btree ("tenant_id","starts_at");--> statement-breakpoint
CREATE INDEX "meetups_tenant_id_status_index" ON "meetups" USING btree ("tenant_id","status");DO $$
DECLARE t text;
BEGIN
  FOREACH t IN ARRAY ARRAY['meetups', 'meetup_registrations', 'webinars', 'webinar_participations', 'complex_tests', 'complex_test_attempts']
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
UPDATE roles SET scopes = array_cat(scopes, ARRAY['meetup.view','meetup.enroll']) WHERE is_system AND code = 'employee' AND NOT scopes @> ARRAY['meetup.view'];
--> statement-breakpoint
UPDATE roles SET scopes = array_cat(scopes, ARRAY['meetup.view','meetup.enroll','meetup.attendance']) WHERE is_system AND code = 'mentor' AND NOT scopes @> ARRAY['meetup.view'];
--> statement-breakpoint
UPDATE roles SET scopes = array_cat(scopes, ARRAY['meetup.view','meetup.enroll','meetup.manage','meetup.attendance','webinar.manage']) WHERE is_system AND code = 'manager' AND NOT scopes @> ARRAY['meetup.view'];
--> statement-breakpoint
UPDATE roles SET scopes = array_cat(scopes, ARRAY['meetup.view','meetup.enroll','meetup.manage','webinar.manage','complextest.manage']) WHERE is_system AND code = 'author' AND NOT scopes @> ARRAY['meetup.view'];
--> statement-breakpoint
UPDATE roles SET scopes = array_cat(scopes, ARRAY['meetup.view','meetup.enroll','meetup.manage','meetup.attendance','webinar.manage','complextest.manage']) WHERE is_system AND code = 'admin' AND NOT scopes @> ARRAY['meetup.view'];
