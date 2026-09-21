CREATE TABLE "position_profile_positions" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	"updated_at" timestamp with time zone DEFAULT now() NOT NULL,
	"tenant_id" uuid NOT NULL,
	"profile_id" uuid NOT NULL,
	"position_id" uuid NOT NULL,
	CONSTRAINT "position_profile_positions_profile_id_position_id_unique" UNIQUE("profile_id","position_id")
);
--> statement-breakpoint
CREATE TABLE "pass_events" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	"updated_at" timestamp with time zone DEFAULT now() NOT NULL,
	"tenant_id" uuid NOT NULL,
	"subject_type" text NOT NULL,
	"subject_id" uuid NOT NULL,
	"enrollment_id" uuid NOT NULL,
	"user_id" uuid NOT NULL,
	"event" text NOT NULL,
	"payload" jsonb DEFAULT '{}' NOT NULL,
	"actor_id" uuid,
	"request_context" jsonb
);
--> statement-breakpoint
ALTER TABLE "position_profile_positions" ADD CONSTRAINT "position_profile_positions_profile_id_position_profiles_id_fk" FOREIGN KEY ("profile_id") REFERENCES "public"."position_profiles"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "position_profile_positions" ADD CONSTRAINT "position_profile_positions_position_id_positions_id_fk" FOREIGN KEY ("position_id") REFERENCES "public"."positions"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "pass_events" ADD CONSTRAINT "pass_events_user_id_users_id_fk" FOREIGN KEY ("user_id") REFERENCES "public"."users"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
CREATE INDEX "position_profile_positions_tenant_id_position_id_index" ON "position_profile_positions" USING btree ("tenant_id","position_id");--> statement-breakpoint
CREATE INDEX "pass_events_tenant_id_created_at_index" ON "pass_events" USING btree ("tenant_id","created_at" DESC NULLS LAST);--> statement-breakpoint
CREATE INDEX "pass_events_tenant_id_user_id_created_at_index" ON "pass_events" USING btree ("tenant_id","user_id","created_at" DESC NULLS LAST);--> statement-breakpoint
CREATE INDEX "pass_events_tenant_id_subject_type_subject_id_index" ON "pass_events" USING btree ("tenant_id","subject_type","subject_id");--> statement-breakpoint
-- Перечисления (docs/02): предмет журнала — программа или траектория; событие — как у enrollment_events
ALTER TABLE "pass_events" ADD CONSTRAINT "pass_events_subject_type_check" CHECK ("subject_type" IN ('training_program', 'trajectory'));--> statement-breakpoint
ALTER TABLE "pass_events" ADD CONSTRAINT "pass_events_event_check" CHECK ("event" IN ('created', 'started', 'completed', 'failed', 'cancelled', 'reset'));--> statement-breakpoint
-- Таблицы тенанта — RLS обязателен (CLAUDE.md п. 1)
ALTER TABLE pass_events ENABLE ROW LEVEL SECURITY;--> statement-breakpoint
ALTER TABLE pass_events FORCE ROW LEVEL SECURITY;--> statement-breakpoint
CREATE POLICY tenant_isolation ON pass_events
  USING (tenant_id = nullif(current_setting('app.tenant_id', true), '')::uuid)
  WITH CHECK (tenant_id = nullif(current_setting('app.tenant_id', true), '')::uuid);--> statement-breakpoint
ALTER TABLE position_profile_positions ENABLE ROW LEVEL SECURITY;--> statement-breakpoint
ALTER TABLE position_profile_positions FORCE ROW LEVEL SECURITY;--> statement-breakpoint
CREATE POLICY tenant_isolation ON position_profile_positions
  USING (tenant_id = nullif(current_setting('app.tenant_id', true), '')::uuid)
  WITH CHECK (tenant_id = nullif(current_setting('app.tenant_id', true), '')::uuid);--> statement-breakpoint
-- Бекфіл (D-031): головна посада кожного профілю стає його першою посадою
INSERT INTO position_profile_positions (tenant_id, profile_id, position_id) SELECT tenant_id, id, position_id FROM position_profiles ON CONFLICT DO NOTHING;
