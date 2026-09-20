-- docs/33 D-052: «Переглянути систему як роль» — preview_role_id на сесії, права рахуються по ній (loadAccess).
ALTER TABLE "sessions" ADD COLUMN "preview_role_id" uuid;--> statement-breakpoint
-- docs/33 D-053: замок модуля по тарифу. NULL — без обмежень (усі наявні тарифи лишаються без замку,
-- бо конкретна матриця «який модуль на якому тарифі» не описана в ТЗ — рішення без замовника не вигадуємо,
-- механізм вмикається завданням конкретного плану `modules`, докс/28 Spec 24).
ALTER TABLE "plans" ADD COLUMN "modules" text[];--> statement-breakpoint
ALTER TABLE "sessions" ADD CONSTRAINT "sessions_preview_role_id_roles_id_fk" FOREIGN KEY ("preview_role_id") REFERENCES "public"."roles"("id") ON DELETE set null ON UPDATE no action;--> statement-breakpoint
-- auth_session_by_token (0035) повертає ще й preview_role_id — для AuthContext.previewRoleId.
DROP FUNCTION IF EXISTS auth_session_by_token(text);--> statement-breakpoint
CREATE FUNCTION auth_session_by_token(p_token_hash text)
RETURNS TABLE (
  session_id uuid, tenant_id uuid, user_id uuid,
  expires_at timestamptz, revoked_at timestamptz, impersonated_by uuid, active_role_id uuid,
  impersonator_admin_id uuid, preview_role_id uuid
)
LANGUAGE sql SECURITY DEFINER STABLE
SET search_path = public
AS $$
  SELECT s.id, s.tenant_id, s.user_id, s.expires_at, s.revoked_at, s.impersonated_by, s.active_role_id, s.impersonator_admin_id, s.preview_role_id
  FROM sessions s
  WHERE s.token_hash = p_token_hash;
$$;--> statement-breakpoint
REVOKE ALL ON FUNCTION auth_session_by_token(text) FROM public;--> statement-breakpoint
GRANT EXECUTE ON FUNCTION auth_session_by_token(text) TO app_user;