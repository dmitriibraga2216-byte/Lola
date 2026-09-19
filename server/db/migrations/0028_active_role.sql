CREATE TABLE "position_role_map" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	"updated_at" timestamp with time zone DEFAULT now() NOT NULL,
	"tenant_id" uuid NOT NULL,
	"position_id" uuid NOT NULL,
	"role_id" uuid NOT NULL,
	"scope_type" text DEFAULT 'location' NOT NULL,
	"scope_id" uuid,
	CONSTRAINT "position_role_map_tenant_id_position_id_role_id_scope_type_scope_id_unique" UNIQUE("tenant_id","position_id","role_id","scope_type","scope_id")
);
--> statement-breakpoint
ALTER TABLE "sessions" ADD COLUMN "active_role_id" uuid;--> statement-breakpoint
ALTER TABLE "user_roles" ADD COLUMN "valid_until" timestamp with time zone;--> statement-breakpoint
ALTER TABLE "user_roles" ADD COLUMN "reason" text;--> statement-breakpoint
ALTER TABLE "user_roles" ADD COLUMN "is_org_derived" boolean DEFAULT false NOT NULL;--> statement-breakpoint
ALTER TABLE "audit_log" ADD COLUMN "actor_role_id" uuid;--> statement-breakpoint
ALTER TABLE "audit_log" ADD COLUMN "actor_roles" text[];--> statement-breakpoint
ALTER TABLE "position_role_map" ADD CONSTRAINT "position_role_map_position_id_positions_id_fk" FOREIGN KEY ("position_id") REFERENCES "public"."positions"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "position_role_map" ADD CONSTRAINT "position_role_map_role_id_roles_id_fk" FOREIGN KEY ("role_id") REFERENCES "public"."roles"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
CREATE INDEX "position_role_map_tenant_id_index" ON "position_role_map" USING btree ("tenant_id");--> statement-breakpoint
ALTER TABLE "sessions" ADD CONSTRAINT "sessions_active_role_id_roles_id_fk" FOREIGN KEY ("active_role_id") REFERENCES "public"."roles"("id") ON DELETE set null ON UPDATE no action;--> statement-breakpoint
-- Правило «должность → роль» (docs/01 §1.9.3, docs/02): таблица тенанта — RLS обязателен (CLAUDE.md п. 1)
ALTER TABLE position_role_map ENABLE ROW LEVEL SECURITY;--> statement-breakpoint
ALTER TABLE position_role_map FORCE ROW LEVEL SECURITY;--> statement-breakpoint
CREATE POLICY tenant_isolation ON position_role_map
  USING (tenant_id = nullif(current_setting('app.tenant_id', true), '')::uuid)
  WITH CHECK (tenant_id = nullif(current_setting('app.tenant_id', true), '')::uuid);--> statement-breakpoint
ALTER TABLE "position_role_map" ADD CONSTRAINT "position_role_map_scope_type_check" CHECK ("scope_type" IN ('tenant', 'org_unit', 'location'));--> statement-breakpoint
-- Сессия узнаёт активную роль до выбора тенанта: та же SECURITY DEFINER «дверь», что в 0003, с новой колонкой
DROP FUNCTION IF EXISTS auth_session_by_token(text);--> statement-breakpoint
CREATE FUNCTION auth_session_by_token(p_token_hash text)
RETURNS TABLE (
  session_id uuid, tenant_id uuid, user_id uuid,
  expires_at timestamptz, revoked_at timestamptz, impersonated_by uuid, active_role_id uuid
)
LANGUAGE sql SECURITY DEFINER STABLE
SET search_path = public
AS $$
  SELECT s.id, s.tenant_id, s.user_id, s.expires_at, s.revoked_at, s.impersonated_by, s.active_role_id
  FROM sessions s
  WHERE s.token_hash = p_token_hash;
$$;--> statement-breakpoint
REVOKE ALL ON FUNCTION auth_session_by_token(text) FROM public;--> statement-breakpoint
GRANT EXECUTE ON FUNCTION auth_session_by_token(text) TO app_user;--> statement-breakpoint
-- Живые сессии получают роль по умолчанию (docs/28 «Паритет 4»: admin → author → manager → mentor → своя роль → employee)
UPDATE sessions s SET active_role_id = (
  SELECT ur.role_id FROM user_roles ur JOIN roles r ON r.id = ur.role_id
  WHERE ur.user_id = s.user_id AND (ur.valid_until IS NULL OR ur.valid_until > now())
  ORDER BY CASE r.code WHEN 'admin' THEN 0 WHEN 'author' THEN 1 WHEN 'manager' THEN 2 WHEN 'mentor' THEN 3 WHEN 'employee' THEN 5 ELSE 4 END, r.name, ur.created_at
  LIMIT 1
) WHERE s.active_role_id IS NULL AND s.revoked_at IS NULL AND s.expires_at > now();
