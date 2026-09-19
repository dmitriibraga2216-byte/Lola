CREATE TABLE "oauth_states" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	"updated_at" timestamp with time zone DEFAULT now() NOT NULL,
	"tenant_id" uuid NOT NULL,
	"provider" text NOT NULL,
	"state_hash" text NOT NULL,
	"purpose" text DEFAULT 'connect' NOT NULL,
	"created_by" uuid,
	"expires_at" timestamp with time zone NOT NULL,
	"consumed_at" timestamp with time zone,
	CONSTRAINT "oauth_states_state_hash_unique" UNIQUE("state_hash")
);
--> statement-breakpoint
ALTER TABLE "meetups" ADD COLUMN "external_event_id" text;--> statement-breakpoint
ALTER TABLE "webinars" ADD COLUMN "external_meeting_id" text;ALTER TABLE oauth_states ENABLE ROW LEVEL SECURITY;
--> statement-breakpoint
ALTER TABLE oauth_states FORCE ROW LEVEL SECURITY;
--> statement-breakpoint
CREATE POLICY tenant_isolation ON oauth_states
  USING (tenant_id = nullif(current_setting('app.tenant_id', true), '')::uuid)
  WITH CHECK (tenant_id = nullif(current_setting('app.tenant_id', true), '')::uuid);
--> statement-breakpoint
-- Колбек OAuth приходит без сессии: state ищется по хэшу до установки tenant_id (SECURITY DEFINER, как auth_session_by_token)
CREATE OR REPLACE FUNCTION oauth_state_lookup(p_hash text)
RETURNS TABLE (id uuid, tenant_id uuid, provider text, purpose text, created_by uuid, expires_at timestamptz, consumed_at timestamptz)
LANGUAGE sql SECURITY DEFINER SET search_path = public AS $$
  SELECT id, tenant_id, provider, purpose, created_by, expires_at, consumed_at FROM oauth_states WHERE state_hash = p_hash
$$;
--> statement-breakpoint
GRANT EXECUTE ON FUNCTION oauth_state_lookup(text) TO app_user;
