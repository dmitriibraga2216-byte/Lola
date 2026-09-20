CREATE TABLE "meetup_session_registrations" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	"updated_at" timestamp with time zone DEFAULT now() NOT NULL,
	"tenant_id" uuid NOT NULL,
	"session_id" uuid NOT NULL,
	"user_id" uuid NOT NULL,
	"status" text DEFAULT 'registered' NOT NULL,
	"registered_at" timestamp with time zone DEFAULT now() NOT NULL,
	"registered_by" uuid,
	"waitlist_position" integer,
	"checked_in_at" timestamp with time zone,
	"check_in_method" text,
	"checked_in_by" uuid,
	"cancel_reason" text,
	"guests_count" integer DEFAULT 0 NOT NULL,
	"enrollment_id" uuid,
	"lesson_id" uuid,
	"seconds_watched" integer DEFAULT 0 NOT NULL,
	"watch_pct" numeric(5, 2),
	"last_tick_at" timestamp with time zone,
	"marked_retroactively" boolean DEFAULT false NOT NULL,
	"retroactive_reason" text,
	CONSTRAINT "meetup_session_registrations_session_id_user_id_unique" UNIQUE("session_id","user_id")
);
--> statement-breakpoint
CREATE TABLE "meetup_sessions" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	"updated_at" timestamp with time zone DEFAULT now() NOT NULL,
	"tenant_id" uuid NOT NULL,
	"meetup_id" uuid NOT NULL,
	"task_id" uuid,
	"starts_at" timestamp with time zone NOT NULL,
	"ends_at" timestamp with time zone NOT NULL,
	"timezone" text DEFAULT 'Europe/Kyiv' NOT NULL,
	"location_id" uuid,
	"room" text,
	"address" text,
	"trainer_ids" uuid[] DEFAULT '{}'::uuid[] NOT NULL,
	"join_url" text,
	"host_url" text,
	"record_url" text,
	"provider" text,
	"capacity" integer,
	"waitlist_enabled" boolean DEFAULT true NOT NULL,
	"enroll_deadline_hours" integer DEFAULT 2 NOT NULL,
	"cancel_deadline_hours" integer DEFAULT 24 NOT NULL,
	"attendance_mode" text DEFAULT 'manual' NOT NULL,
	"qr_secret" text NOT NULL,
	"status" text DEFAULT 'planned' NOT NULL,
	"cancel_reason" text,
	"created_by" uuid
);
--> statement-breakpoint
ALTER TABLE "meetups" ADD COLUMN "announcement" jsonb DEFAULT '[]' NOT NULL;--> statement-breakpoint
ALTER TABLE "meetups" ADD COLUMN "tags" text[] DEFAULT '{}'::text[] NOT NULL;--> statement-breakpoint
ALTER TABLE "meetup_session_registrations" ADD CONSTRAINT "meetup_session_registrations_session_id_meetup_sessions_id_fk" FOREIGN KEY ("session_id") REFERENCES "public"."meetup_sessions"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "meetup_session_registrations" ADD CONSTRAINT "meetup_session_registrations_user_id_users_id_fk" FOREIGN KEY ("user_id") REFERENCES "public"."users"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "meetup_session_registrations" ADD CONSTRAINT "meetup_session_registrations_registered_by_users_id_fk" FOREIGN KEY ("registered_by") REFERENCES "public"."users"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "meetup_session_registrations" ADD CONSTRAINT "meetup_session_registrations_checked_in_by_users_id_fk" FOREIGN KEY ("checked_in_by") REFERENCES "public"."users"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "meetup_sessions" ADD CONSTRAINT "meetup_sessions_meetup_id_meetups_id_fk" FOREIGN KEY ("meetup_id") REFERENCES "public"."meetups"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "meetup_sessions" ADD CONSTRAINT "meetup_sessions_task_id_assignments_id_fk" FOREIGN KEY ("task_id") REFERENCES "public"."assignments"("id") ON DELETE set null ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "meetup_sessions" ADD CONSTRAINT "meetup_sessions_location_id_locations_id_fk" FOREIGN KEY ("location_id") REFERENCES "public"."locations"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "meetup_sessions" ADD CONSTRAINT "meetup_sessions_created_by_users_id_fk" FOREIGN KEY ("created_by") REFERENCES "public"."users"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
CREATE INDEX "meetup_session_registrations_tenant_id_user_id_status_index" ON "meetup_session_registrations" USING btree ("tenant_id","user_id","status");--> statement-breakpoint
CREATE INDEX "meetup_session_registrations_tenant_id_session_id_index" ON "meetup_session_registrations" USING btree ("tenant_id","session_id");--> statement-breakpoint
CREATE INDEX "meetup_sessions_tenant_id_starts_at_index" ON "meetup_sessions" USING btree ("tenant_id","starts_at");--> statement-breakpoint
CREATE INDEX "meetup_sessions_tenant_id_meetup_id_index" ON "meetup_sessions" USING btree ("tenant_id","meetup_id");--> statement-breakpoint
CREATE INDEX "meetup_sessions_tenant_id_task_id_index" ON "meetup_sessions" USING btree ("tenant_id","task_id");--> statement-breakpoint
-- Таблицы тенанта — RLS обязателен (CLAUDE.md п. 1)
ALTER TABLE meetup_sessions ENABLE ROW LEVEL SECURITY;--> statement-breakpoint
ALTER TABLE meetup_sessions FORCE ROW LEVEL SECURITY;--> statement-breakpoint
CREATE POLICY tenant_isolation ON meetup_sessions
  USING (tenant_id = nullif(current_setting('app.tenant_id', true), '')::uuid)
  WITH CHECK (tenant_id = nullif(current_setting('app.tenant_id', true), '')::uuid);--> statement-breakpoint
ALTER TABLE meetup_session_registrations ENABLE ROW LEVEL SECURITY;--> statement-breakpoint
ALTER TABLE meetup_session_registrations FORCE ROW LEVEL SECURITY;--> statement-breakpoint
CREATE POLICY tenant_isolation ON meetup_session_registrations
  USING (tenant_id = nullif(current_setting('app.tenant_id', true), '')::uuid)
  WITH CHECK (tenant_id = nullif(current_setting('app.tenant_id', true), '')::uuid);