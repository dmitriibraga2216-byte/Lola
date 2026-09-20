CREATE TABLE "comments" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	"updated_at" timestamp with time zone DEFAULT now() NOT NULL,
	"tenant_id" uuid NOT NULL,
	"author_id" uuid NOT NULL,
	"body" text NOT NULL,
	"source_type" text NOT NULL,
	"source_id" uuid NOT NULL,
	"is_read" boolean DEFAULT false NOT NULL,
	"read_by" uuid,
	"read_at" timestamp with time zone,
	"routed_to" uuid,
	"reply_to_id" uuid
);
--> statement-breakpoint
ALTER TABLE "courses" ADD COLUMN "assign_mode" text DEFAULT 'catalog_free' NOT NULL;--> statement-breakpoint
ALTER TABLE "enrollments" ADD COLUMN "requested_at" timestamp with time zone;--> statement-breakpoint
ALTER TABLE "program_enrollments" ADD COLUMN "cancel_reason" text;--> statement-breakpoint
ALTER TABLE "comments" ADD CONSTRAINT "comments_author_id_users_id_fk" FOREIGN KEY ("author_id") REFERENCES "public"."users"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "comments" ADD CONSTRAINT "comments_read_by_users_id_fk" FOREIGN KEY ("read_by") REFERENCES "public"."users"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "comments" ADD CONSTRAINT "comments_routed_to_users_id_fk" FOREIGN KEY ("routed_to") REFERENCES "public"."users"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "comments" ADD CONSTRAINT "comments_reply_to_id_comments_id_fk" FOREIGN KEY ("reply_to_id") REFERENCES "public"."comments"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
CREATE INDEX "comments_tenant_id_source_type_source_id_index" ON "comments" USING btree ("tenant_id","source_type","source_id");--> statement-breakpoint
CREATE INDEX "comments_tenant_id_is_read_index" ON "comments" USING btree ("tenant_id","is_read");--> statement-breakpoint
ALTER TABLE "courses" ADD CONSTRAINT "courses_assign_mode_check" CHECK ("assign_mode" IN ('catalog_free', 'catalog_request'));--> statement-breakpoint
ALTER TABLE comments ENABLE ROW LEVEL SECURITY;--> statement-breakpoint
ALTER TABLE comments FORCE ROW LEVEL SECURITY;--> statement-breakpoint
CREATE POLICY tenant_isolation ON comments
  USING (tenant_id = nullif(current_setting('app.tenant_id', true), '')::uuid)
  WITH CHECK (tenant_id = nullif(current_setting('app.tenant_id', true), '')::uuid);