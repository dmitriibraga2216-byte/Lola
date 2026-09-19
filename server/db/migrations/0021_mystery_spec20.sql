CREATE TABLE "mystery_links" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	"updated_at" timestamp with time zone DEFAULT now() NOT NULL,
	"tenant_id" uuid NOT NULL,
	"wave_id" uuid NOT NULL,
	"location_id" uuid NOT NULL,
	"token_hash" text NOT NULL,
	"expires_at" timestamp with time zone NOT NULL,
	"used_at" timestamp with time zone,
	"run_id" uuid,
	"created_by" uuid NOT NULL,
	CONSTRAINT "mystery_links_token_hash_unique" UNIQUE("token_hash")
);
--> statement-breakpoint
CREATE TABLE "mystery_waves" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	"updated_at" timestamp with time zone DEFAULT now() NOT NULL,
	"tenant_id" uuid NOT NULL,
	"checklist_id" uuid NOT NULL,
	"title" text NOT NULL,
	"starts_at" date NOT NULL,
	"ends_at" date NOT NULL,
	"status" text DEFAULT 'active' NOT NULL,
	"published_at" timestamp with time zone,
	"created_by" uuid
);
--> statement-breakpoint
ALTER TABLE "checklist_runs" ADD COLUMN "wave_id" uuid;--> statement-breakpoint
ALTER TABLE "checklist_runs" ADD COLUMN "is_external" boolean DEFAULT false NOT NULL;--> statement-breakpoint
ALTER TABLE "mystery_links" ADD CONSTRAINT "mystery_links_wave_id_mystery_waves_id_fk" FOREIGN KEY ("wave_id") REFERENCES "public"."mystery_waves"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "mystery_links" ADD CONSTRAINT "mystery_links_location_id_locations_id_fk" FOREIGN KEY ("location_id") REFERENCES "public"."locations"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "mystery_links" ADD CONSTRAINT "mystery_links_run_id_checklist_runs_id_fk" FOREIGN KEY ("run_id") REFERENCES "public"."checklist_runs"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "mystery_links" ADD CONSTRAINT "mystery_links_created_by_users_id_fk" FOREIGN KEY ("created_by") REFERENCES "public"."users"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "mystery_waves" ADD CONSTRAINT "mystery_waves_checklist_id_checklists_id_fk" FOREIGN KEY ("checklist_id") REFERENCES "public"."checklists"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "mystery_waves" ADD CONSTRAINT "mystery_waves_created_by_users_id_fk" FOREIGN KEY ("created_by") REFERENCES "public"."users"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
CREATE INDEX "mystery_waves_tenant_id_status_index" ON "mystery_waves" USING btree ("tenant_id","status");
--> statement-breakpoint
DO $$
DECLARE t text;
BEGIN
  FOREACH t IN ARRAY ARRAY['mystery_waves', 'mystery_links']
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
-- Ссылка тайного покупателя открывается без сессии: ищем по хэшу до установки tenant_id (как oauth_state_lookup)
CREATE OR REPLACE FUNCTION mystery_link_lookup(p_hash text)
RETURNS TABLE (id uuid, tenant_id uuid, wave_id uuid, location_id uuid, expires_at timestamptz, used_at timestamptz, run_id uuid, created_by uuid)
LANGUAGE sql SECURITY DEFINER SET search_path = public AS $$
  SELECT id, tenant_id, wave_id, location_id, expires_at, used_at, run_id, created_by FROM mystery_links WHERE token_hash = p_hash
$$;
--> statement-breakpoint
GRANT EXECUTE ON FUNCTION mystery_link_lookup(text) TO app_user;
