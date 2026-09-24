-- Фоновые задачи после сбоя, длившегося с 19.09.2026 до этой миграции (docs/25 §5, §17; docs/v2/46): три части.
--
-- 1. Источники тенантов для кругов (docs/28 «Очередь»).
--    `notification.dispatch`, `attempt.expire` и `webhook.deliver` обходят не все тенанты, а только
--    тех, у кого есть работа. До этой миграции список строился запросом
--    `select distinct tenant_id from <таблица>` с общего соединения приложения — ролью `app_user`,
--    без `app.tenant_id`. Таблицы под `force row level security`, политика сравнивает `tenant_id`
--    с `nullif(current_setting('app.tenant_id', true), '')::uuid`, то есть с NULL, — и запрос
--    всегда возвращал ноль строк. Круг не обслуживал ни одного тенанта: уведомления оставались
--    в `queued`, просроченные попытки не закрывались, вебхуки не уходили.
--
--    Решение повторяет существующие узкие «двери» сквозь RLS (`auth_*` в 0003,
--    `oauth_state_lookup`, `mystery_link_lookup`, `vacancy_public_lookup`): функция
--    `SECURITY DEFINER`, которая отдаёт **только идентификаторы тенантов** — ни одного поля
--    самих строк. Работа с данными по-прежнему идёт в `withTenant()` каждого тенанта.
--    Обход по таблице `tenants` с `exists` даёт по одной пробе индекса
--    `(tenant_id, status, …)` на тенант вместо полного прохода по таблице, которая растёт
--    всю жизнь тенанта (отправленные уведомления, завершённые попытки, доставленные вебхуки).
--    Статус тенанта здесь не проверяется: приостановленных пропускает `runPerTenant`
--    (docs/25 §14 п. 10) — правило живёт в одном месте. `search_path` закреплён, `pg_temp` —
--    последним (рекомендация документации Postgres для `SECURITY DEFINER`); выполнять может
--    только роль приложения.
--
-- 2. Прежние «двери» `oauth_state_lookup` (0015), `mystery_link_lookup` (0021) и
--    `vacancy_public_lookup` (0074) создавались без `REVOKE … FROM public` и были доступны любой
--    роли базы — в отличие от `auth_*` (0003). Теперь, как и новые, — только `app_user`.
--
-- 3. Разовая уборка накопленного за сбой (решение владельца продукта 25.09.2026: «старое не
--    отправлять»). Уведомления в `queued` и доставки вебхуков в `pending`, чей срок прошёл больше
--    суток назад, переводятся в `failed` с причиной — существующий статус «не отправлено» и
--    свободное текстовое поле причины (`notifications.error`, `webhook_deliveries.response_body`),
--    нового значения перечисления нет (CLAUDE.md п. 13). Не `skipped`: колокольчик показывает
--    `skipped` как пришедшее, и человек увидел бы ту же пачку старых новостей. Свежее (моложе
--    суток) уходит как обычно.
--
--    Почему миграция, а не задача при старте: сервис `migrate` выполняется до старта приложения
--    (`depends_on: migrate: service_completed_successfully` в docker/docker-compose.prod.yml и
--    docker-compose.demo.yml), то есть строго до первого круга `notification.dispatch` новой версии;
--    выполняется ровно один раз (журнал drizzle), без отметок «уже сделано»; и ходит ролью `lola`
--    (`DATABASE_ADMIN_URL`, суперпользователь из `POSTGRES_USER`), для которой RLS не действует, —
--    один запрос на все тенанты. Задача при старте работала бы под `app_user` (понадобилась бы ещё
--    одна «дверь», уже на запись, или обход по тенантам), выполнялась бы при каждом перезапуске
--    (нужна отметка «уже сделано»), а её порядок относительно первого круга воркера пришлось бы
--    обеспечивать в коде. Это не «долгий перенос данных» из docs/25 §12: набор
--    ограничен накопленным с 19.09, блокируются только сами эти строки, а старая версия, которая
--    ещё работает во время миграции, их не трогает — её круги видят пустой список тенантов.

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
GRANT EXECUTE ON FUNCTION tenants_with_pending_webhooks() TO app_user;--> statement-breakpoint

REVOKE ALL ON FUNCTION oauth_state_lookup(text) FROM public;--> statement-breakpoint
REVOKE ALL ON FUNCTION mystery_link_lookup(text) FROM public;--> statement-breakpoint
REVOKE ALL ON FUNCTION vacancy_public_lookup(text) FROM public;--> statement-breakpoint
GRANT EXECUTE ON FUNCTION oauth_state_lookup(text) TO app_user;--> statement-breakpoint
GRANT EXECUTE ON FUNCTION mystery_link_lookup(text) TO app_user;--> statement-breakpoint
GRANT EXECUTE ON FUNCTION vacancy_public_lookup(text) TO app_user;--> statement-breakpoint

-- Разовая уборка (часть 3): текст причины — префикс «Не надіслано: збій фонової доставки»,
-- по нему находит пропущенные приглашения запрос из docs/25 §17.1.
UPDATE notifications
   SET status = 'failed',
       error = 'Не надіслано: збій фонової доставки з 19.09.2026; на момент виправлення сповіщення було старше доби',
       updated_at = now()
 WHERE status = 'queued' AND scheduled_for < now() - interval '24 hours';
--> statement-breakpoint

UPDATE webhook_deliveries
   SET status = 'failed',
       response_body = 'Не надіслано: збій фонової доставки з 19.09.2026; на момент виправлення доставка була старша за добу',
       updated_at = now()
 WHERE status = 'pending' AND next_attempt_at < now() - interval '24 hours';
