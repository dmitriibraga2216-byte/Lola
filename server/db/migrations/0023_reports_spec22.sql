CREATE TABLE "report_exports" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	"updated_at" timestamp with time zone DEFAULT now() NOT NULL,
	"tenant_id" uuid NOT NULL,
	"user_id" uuid NOT NULL,
	"report" text NOT NULL,
	"filters" jsonb DEFAULT '{}' NOT NULL,
	"format" text DEFAULT 'xlsx' NOT NULL,
	"status" text DEFAULT 'queued' NOT NULL,
	"rows" integer,
	"file_key" text,
	"error" text,
	"expires_at" timestamp with time zone,
	"finished_at" timestamp with time zone
);
--> statement-breakpoint
ALTER TABLE "workshop_submissions" ADD COLUMN "mentor_rating" integer;--> statement-breakpoint
ALTER TABLE "saved_reports" ADD COLUMN "format" text DEFAULT 'xlsx' NOT NULL;--> statement-breakpoint
ALTER TABLE "saved_reports" ADD COLUMN "sort" text;--> statement-breakpoint
ALTER TABLE "report_exports" ADD CONSTRAINT "report_exports_user_id_users_id_fk" FOREIGN KEY ("user_id") REFERENCES "public"."users"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
CREATE INDEX "report_exports_tenant_id_user_id_created_at_index" ON "report_exports" USING btree ("tenant_id","user_id","created_at" DESC NULLS LAST);
--> statement-breakpoint
ALTER TABLE report_exports ENABLE ROW LEVEL SECURITY;--> statement-breakpoint
ALTER TABLE report_exports FORCE ROW LEVEL SECURITY;--> statement-breakpoint
CREATE POLICY tenant_isolation ON report_exports
  USING (tenant_id = nullif(current_setting('app.tenant_id', true), '')::uuid)
  WITH CHECK (tenant_id = nullif(current_setting('app.tenant_id', true), '')::uuid);
