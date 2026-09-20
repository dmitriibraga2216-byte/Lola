ALTER TABLE "tags" DROP CONSTRAINT "tags_tenant_id_name_unique";--> statement-breakpoint
ALTER TABLE "users" ADD COLUMN "must_change_password" boolean DEFAULT false NOT NULL;--> statement-breakpoint
ALTER TABLE "users" ADD COLUMN "password_changed_at" timestamp with time zone;--> statement-breakpoint
ALTER TABLE "tags" ADD COLUMN "description" text;--> statement-breakpoint
-- Метки: область действия обязательна (docs/16 §14.2). Прежний kind any|people|content|assignment → scope
ALTER TABLE "tags" ADD COLUMN "scope" text;--> statement-breakpoint
UPDATE "tags" SET "scope" = CASE "kind" WHEN 'content' THEN 'course' WHEN 'assignment' THEN 'task' ELSE 'user' END;--> statement-breakpoint
ALTER TABLE "tags" ALTER COLUMN "scope" SET NOT NULL;--> statement-breakpoint
ALTER TABLE "tags" ADD CONSTRAINT "tags_scope_tag_scope" CHECK ("scope" in ('user', 'course', 'resource', 'question', 'task'));--> statement-breakpoint
ALTER TABLE "user_groups" ADD COLUMN "is_org_derived" boolean DEFAULT false NOT NULL;--> statement-breakpoint
ALTER TABLE "user_groups" ADD COLUMN "org_unit_id" uuid;--> statement-breakpoint
ALTER TABLE "user_groups" ADD COLUMN "location_id" uuid;--> statement-breakpoint
ALTER TABLE "user_groups" ADD CONSTRAINT "user_groups_org_unit_id_org_units_id_fk" FOREIGN KEY ("org_unit_id") REFERENCES "public"."org_units"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "user_groups" ADD CONSTRAINT "user_groups_location_id_locations_id_fk" FOREIGN KEY ("location_id") REFERENCES "public"."locations"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "tags" DROP COLUMN "kind";--> statement-breakpoint
ALTER TABLE "tags" ADD CONSTRAINT "tags_tenant_id_scope_name_unique" UNIQUE("tenant_id","scope","name");--> statement-breakpoint
-- Конфликты оргструктуры: пятый вид unit_missing (мокап OrgConflicts, org_conflict_kind в docs/02)
ALTER TABLE "org_conflicts" DROP CONSTRAINT "org_conflicts_kind_check";--> statement-breakpoint
ALTER TABLE "org_conflicts" ADD CONSTRAINT "org_conflicts_kind_check" CHECK ("kind" IN ('double_unit', 'placement_replaced', 'manager_self', 'manager_cycle', 'unit_missing'));--> statement-breakpoint
-- Скоуп people.password (docs/04 §4.11: смена пароля администратором — отдельный скоуп) — системному администратору
UPDATE roles SET scopes = array_append(scopes, 'people.password') WHERE is_system AND code = 'admin' AND NOT scopes @> ARRAY['people.password'];--> statement-breakpoint
-- Коды событий журнала безопасности приведены к docs/16 §15 (Г-16.2): старые записи переписаны
UPDATE security_log SET event = 'login.success', meta = meta || jsonb_build_object('method', split_part(event, '.', 2)) WHERE event in ('login.otp', 'login.google', 'login.invite', 'login.telegram');--> statement-breakpoint
UPDATE security_log SET event = 'session.revoked', meta = meta || jsonb_build_object('reason', CASE event WHEN 'logout.all' THEN 'logout_all' ELSE 'logout' END) WHERE event in ('logout', 'logout.all');--> statement-breakpoint
UPDATE security_log SET event = 'contacts.changed', meta = meta || '{"field":"telegram"}'::jsonb WHERE event = 'telegram.linked';--> statement-breakpoint
UPDATE security_log SET event = 'impersonation.started' WHERE event = 'impersonation.start';--> statement-breakpoint
UPDATE security_log SET event = 'impersonation.ended' WHERE event = 'impersonation.stop';--> statement-breakpoint
-- Вход по e-mail + паролю (docs/01 §1.5): предаутентификационный поиск сквозь RLS, как auth_users_by_phone (0003).
-- Хеш пароля наружу не уходит — функцию вызывает только сервер входа.
CREATE OR REPLACE FUNCTION auth_users_by_email(p_email text)
RETURNS TABLE (
  user_id uuid, tenant_id uuid, tenant_slug text, tenant_name text,
  full_name text, status text, is_blocked boolean, password_hash text,
  must_change_password boolean, password_changed_at timestamptz, password_login_enabled boolean
)
LANGUAGE sql SECURITY DEFINER STABLE
SET search_path = public
AS $$
  SELECT u.id, u.tenant_id, t.slug, t.name, u.full_name, u.status, u.is_blocked, u.password_hash,
         u.must_change_password, u.password_changed_at,
         coalesce((t.settings #>> '{policies,passwords,loginEnabled}')::boolean, false)
  FROM users u
  JOIN tenants t ON t.id = u.tenant_id
  WHERE lower(u.email) = lower(p_email)
    AND u.status IN ('invited', 'active')
    AND t.status = 'active';
$$;--> statement-breakpoint
REVOKE ALL ON FUNCTION auth_users_by_email(text) FROM public;--> statement-breakpoint
GRANT EXECUTE ON FUNCTION auth_users_by_email(text) TO app_user;
