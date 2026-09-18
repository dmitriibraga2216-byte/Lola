-- RLS для новой таблицы security_log (правило CLAUDE.md №4: новая таблица — сразу политика).
ALTER TABLE security_log ENABLE ROW LEVEL SECURITY;--> statement-breakpoint
ALTER TABLE security_log FORCE ROW LEVEL SECURITY;--> statement-breakpoint
CREATE POLICY tenant_isolation ON security_log
  USING (tenant_id = nullif(current_setting('app.tenant_id', true), '')::uuid)
  WITH CHECK (tenant_id = nullif(current_setting('app.tenant_id', true), '')::uuid);
--> statement-breakpoint

-- Функции предаутентификационного поиска (SECURITY DEFINER — единственные
-- узкие «двери» сквозь RLS до того, как известен тенант: вход по телефону,
-- проверка cookie сессии, приём приглашения). Владелец — роль миграций.

CREATE OR REPLACE FUNCTION auth_users_by_phone(p_phone text)
RETURNS TABLE (
  user_id uuid, tenant_id uuid, tenant_slug text, tenant_name text,
  full_name text, status text, locale text, has_telegram boolean
)
LANGUAGE sql SECURITY DEFINER STABLE
SET search_path = public
AS $$
  SELECT u.id, u.tenant_id, t.slug, t.name, u.full_name, u.status,
         coalesce(u.locale, t.locale), u.telegram_chat_id IS NOT NULL
  FROM users u
  JOIN tenants t ON t.id = u.tenant_id
  WHERE u.phone = p_phone
    AND u.status IN ('invited', 'active')
    AND t.status = 'active';
$$;
--> statement-breakpoint

CREATE OR REPLACE FUNCTION auth_session_by_token(p_token_hash text)
RETURNS TABLE (
  session_id uuid, tenant_id uuid, user_id uuid,
  expires_at timestamptz, revoked_at timestamptz, impersonated_by uuid
)
LANGUAGE sql SECURITY DEFINER STABLE
SET search_path = public
AS $$
  SELECT s.id, s.tenant_id, s.user_id, s.expires_at, s.revoked_at, s.impersonated_by
  FROM sessions s
  WHERE s.token_hash = p_token_hash;
$$;
--> statement-breakpoint

CREATE OR REPLACE FUNCTION auth_invitation_by_token(p_token_hash text)
RETURNS TABLE (
  invitation_id uuid, tenant_id uuid, user_id uuid,
  expires_at timestamptz, accepted_at timestamptz
)
LANGUAGE sql SECURITY DEFINER STABLE
SET search_path = public
AS $$
  SELECT i.id, i.tenant_id, i.user_id, i.expires_at, i.accepted_at
  FROM invitations i
  WHERE i.token_hash = p_token_hash;
$$;
--> statement-breakpoint

REVOKE ALL ON FUNCTION auth_users_by_phone(text) FROM public;--> statement-breakpoint
REVOKE ALL ON FUNCTION auth_session_by_token(text) FROM public;--> statement-breakpoint
REVOKE ALL ON FUNCTION auth_invitation_by_token(text) FROM public;--> statement-breakpoint
GRANT EXECUTE ON FUNCTION auth_users_by_phone(text) TO app_user;--> statement-breakpoint
GRANT EXECUTE ON FUNCTION auth_session_by_token(text) TO app_user;--> statement-breakpoint
GRANT EXECUTE ON FUNCTION auth_invitation_by_token(text) TO app_user;
