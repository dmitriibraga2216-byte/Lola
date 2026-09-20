-- Spec: вхід по коду на e-mail як другий канал OTP (docs/28 «Вхід: код на e-mail»).
-- auth_users_by_phone (0041) отримує email — предаутентификаційному коду вибору каналу
-- потрібна адреса людини (тенант, куди йде код, ще невідомий заздалегідь). Значення йде лише
-- у службовий SMTP-надсилач (server/services/otpChannel.ts), назовні — тільки маска d***@gmail.com.
DROP FUNCTION IF EXISTS auth_users_by_phone(text);--> statement-breakpoint
CREATE FUNCTION auth_users_by_phone(p_phone text)
RETURNS TABLE (
  user_id uuid, tenant_id uuid, tenant_slug text, tenant_name text,
  full_name text, status text, locale text, has_telegram boolean, tenant_status text, email text
)
LANGUAGE sql SECURITY DEFINER STABLE
SET search_path = public
AS $$
  SELECT u.id, u.tenant_id, t.slug, t.name, u.full_name, u.status,
         coalesce(u.locale, t.locale), u.telegram_chat_id IS NOT NULL, t.status, u.email
  FROM users u
  JOIN tenants t ON t.id = u.tenant_id
  WHERE u.phone = p_phone
    AND u.status IN ('invited', 'active');
$$;--> statement-breakpoint
REVOKE ALL ON FUNCTION auth_users_by_phone(text) FROM public;--> statement-breakpoint
GRANT EXECUTE ON FUNCTION auth_users_by_phone(text) TO app_user;
