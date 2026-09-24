-- Источники тенантов для кругов фоновых задач (docs/25 §5, docs/28 «Очередь»).
--
-- `notification.dispatch`, `attempt.expire` и `webhook.deliver` обходят не все тенанты, а только
-- тех, у кого есть работа. До этой миграции список строился запросом
-- `select distinct tenant_id from <таблица>` с общего соединения приложения — ролью `app_user`,
-- без `app.tenant_id`. Таблицы под `force row level security`, политика сравнивает `tenant_id`
-- с `nullif(current_setting('app.tenant_id', true), '')::uuid`, то есть с NULL, — и запрос
-- всегда возвращал ноль строк. Круг не обслуживал ни одного тенанта: уведомления оставались
-- в `queued`, просроченные попытки не закрывались, вебхуки не уходили.
--
-- Решение повторяет существующие узкие «двери» сквозь RLS (`auth_*` в 0003,
-- `oauth_state_lookup`, `mystery_link_lookup`, `vacancy_public_lookup`): функция
-- `SECURITY DEFINER`, которая отдаёт **только идентификаторы тенантов** — ни одного поля
-- самих строк. Работа с данными по-прежнему идёт в `withTenant()` каждого тенанта.
-- Обход по таблице `tenants` с `exists` даёт по одной пробе индекса
-- `(tenant_id, status, …)` на тенант вместо полного прохода по таблице, которая растёт
-- всю жизнь тенанта (отправленные уведомления, завершённые попытки, доставленные вебхуки).
-- Статус тенанта здесь не проверяется: приостановленных пропускает `runPerTenant`
-- (docs/25 §14 п. 10) — правило живёт в одном месте.
--
-- `search_path` закреплён, `pg_temp` — последним (рекомендация документации Postgres для
-- `SECURITY DEFINER`); выполнять может только роль приложения.

CREATE OR REPLACE FUNCTION tenants_with_queued_notifications()
RETURNS TABLE (tenant_id uuid)
LANGUAGE sql SECURITY DEFINER STABLE
SET search_path = public, pg_temp
AS $$
  SELECT t.id FROM tenants t
  WHERE EXISTS (
    SELECT 1 FROM notifications n
    WHERE n.tenant_id = t.id AND n.status = 'queued' AND n.scheduled_for <= now()
  )
$$;
--> statement-breakpoint

CREATE OR REPLACE FUNCTION tenants_with_active_attempts()
RETURNS TABLE (tenant_id uuid)
LANGUAGE sql SECURITY DEFINER STABLE
SET search_path = public, pg_temp
AS $$
  SELECT t.id FROM tenants t
  WHERE EXISTS (
    SELECT 1 FROM attempts a
    WHERE a.tenant_id = t.id AND a.status = 'in_progress'
  )
$$;
--> statement-breakpoint

CREATE OR REPLACE FUNCTION tenants_with_pending_webhooks()
RETURNS TABLE (tenant_id uuid)
LANGUAGE sql SECURITY DEFINER STABLE
SET search_path = public, pg_temp
AS $$
  SELECT t.id FROM tenants t
  WHERE EXISTS (
    SELECT 1 FROM webhook_deliveries d
    WHERE d.tenant_id = t.id AND d.status = 'pending' AND d.next_attempt_at <= now()
  )
$$;
--> statement-breakpoint

REVOKE ALL ON FUNCTION tenants_with_queued_notifications() FROM public;--> statement-breakpoint
REVOKE ALL ON FUNCTION tenants_with_active_attempts() FROM public;--> statement-breakpoint
REVOKE ALL ON FUNCTION tenants_with_pending_webhooks() FROM public;--> statement-breakpoint
GRANT EXECUTE ON FUNCTION tenants_with_queued_notifications() TO app_user;--> statement-breakpoint
GRANT EXECUTE ON FUNCTION tenants_with_active_attempts() TO app_user;--> statement-breakpoint
GRANT EXECUTE ON FUNCTION tenants_with_pending_webhooks() TO app_user;
