-- docs/01-roles.md §1.2 (системные роли), §1.3 (скоуп `tenant.transfer`), §1.4 (матрица),
-- §1.9.4 (владение) · docs/24-settings-platform.md §3.5 (редактор ролей) ·
-- docs/v2/35-billing-limits.md §2 («`owner` — существующая системная роль тенанта»).
--
-- ── Зачем миграция ────────────────────────────────────────────────────────────────────
-- `docs/v2/35` §2 уже год ссылается на роль `owner` как на существующую: суммы платежей и
-- смену тарифа она отдаёт только ей. В `01` §1.2 такой роли не было — пять системных ролей
-- заканчивались администратором. Расхождение закрыто здесь: роль заводится, матрица `01`
-- правится пометкой «исправлено», а у `admin` **забираются** три скоупа, которые по `35` §2
-- ему не принадлежат (`billing.payments.view`, `billing.manage`) и не могут принадлежать
-- (`tenant.transfer` — новый скоуп, см. ниже).
--
-- ── Инвариант «владелец в тенанте ровно один» ─────────────────────────────────────────
-- Он обязан держаться в схеме, а не в сервисе: две одновременные передачи владения,
-- прошедшие проверку сервиса, обязаны кончиться ошибкой уникальности, а не двумя
-- владельцами. Прямого способа это выразить нет — «ровно один» здесь про `(tenant_id)`
-- при условии «роль этого назначения называется owner», а условие частичного индекса
-- читать соседнюю таблицу не умеет. Поэтому признак денормализован в колонку
-- `user_roles.is_owner`, которую **пишет только триггер** из кода роли, а поверх неё стоит
-- частичный уникальный индекс. Колонка, которую нельзя изменить руками, и индекс поверх
-- неё — это ровно «частичный уникальный индекс по владельцу», просто выраженный в два шага.
--
-- ── Кто становится владельцем у существующих тенантов ─────────────────────────────────
-- Никто. `[решение]` Роль создаётся пустой. Раздать владение по всей базе (например,
-- «самому старому администратору») — значит молча назначить подписанта договора и
-- распорядителя тарифом за спиной у людей; в тенанте с тремя администраторами выбор
-- между ними некому обосновать. Вместо этого экран ролей показывает администратору
-- карточку «Простір без власника» с одноразовой кнопкой «Стати власником»
-- (`POST /settings/owner/claim`, `server/services/owner.ts`): кто нажал — тот и владелец,
-- второй уже видит имя первого. Гонку разруливает тот же уникальный индекс.
-- Новые тенанты приходят с владельцем сразу (`server/services/platform.ts`: создатель
-- тенанта получает и `admin`, и `owner`).

-- ── 1. Признак владения на назначении роли ────────────────────────────────────────────
ALTER TABLE "user_roles" ADD COLUMN IF NOT EXISTS "is_owner" boolean DEFAULT false NOT NULL;--> statement-breakpoint

-- Триггер — единственный писатель колонки: значение берётся из кода роли, поэтому
-- `is_owner` не может разойтись с `roles.code`, что бы ни передал вызывающий.
-- SECURITY DEFINER не нужен: `roles` живёт в том же тенанте, что и назначение, и видна
-- под той же политикой RLS, в которой идёт вставка.
CREATE OR REPLACE FUNCTION user_roles_is_owner() RETURNS trigger LANGUAGE plpgsql AS $$
BEGIN
  NEW.is_owner := EXISTS (SELECT 1 FROM roles r WHERE r.id = NEW.role_id AND r.code = 'owner');
  RETURN NEW;
END $$;--> statement-breakpoint

DROP TRIGGER IF EXISTS user_roles_is_owner_trg ON user_roles;--> statement-breakpoint
CREATE TRIGGER user_roles_is_owner_trg BEFORE INSERT OR UPDATE OF role_id
  ON user_roles FOR EACH ROW EXECUTE FUNCTION user_roles_is_owner();--> statement-breakpoint

-- Тот самый инвариант. Частичный — потому что назначений не-владельческих ролей в тенанте
-- сколько угодно, а владельческое ровно одно.
CREATE UNIQUE INDEX IF NOT EXISTS "user_roles_single_owner_uq" ON "user_roles" ("tenant_id") WHERE "is_owner";--> statement-breakpoint

-- ── 2. Системная роль «Власник» в каждом существующем тенанте ─────────────────────────
-- Набор прав дословно повторяет `SYSTEM_ROLES.owner` из `shared/domain/roles.ts` — там же
-- объяснено, почему именно он (администратор ведёт систему, владелец — деньги, владение и
-- людей). Держать список в двух местах приходится: сид и создание тенанта читают TypeScript,
-- существующие тенанты чинятся только SQL. Расхождение ловит
-- `tests/integration/roles-owner.spec.ts` («набор роли в БД совпадает с SYSTEM_ROLES»).
INSERT INTO roles (tenant_id, code, name, scopes, is_system, default_scope_type, description)
SELECT t.id, 'owner', 'Власник', ARRAY[
  'learn.view', 'learn.catalog', 'learn.attempt', 'report.own',
  'people.view', 'people.invite', 'people.edit', 'people.deactivate', 'role.assign',
  'org.structure.view',
  'tenant.transfer', 'settings.tenant',
  'billing.view', 'billing.usage.view', 'billing.payments.view', 'billing.manage',
  'storage.view', 'storage.policy', 'storage.addon',
  'audit.view', 'report.team', 'report.tenant', 'report.export'
]::text[], true, 'tenant', 'Власник простору: тариф і оплата, передача володіння, призначення адміністраторів'
FROM tenants t
ON CONFLICT (tenant_id, code) DO NOTHING;--> statement-breakpoint

-- ── 3. У администратора забираем деньги и владение (`v2/35` §2) ───────────────────────
-- Только у системной роли `admin`: свои роли тенанта трогать нельзя — их набор собирал
-- человек, и `tenant.transfer` в них всё равно взяться неоткуда (скоуп новый), а
-- `billing.manage` администратор мог выдать своей роли осознанно; молча отбирать выданное
-- у чужой роли эта миграция не вправе.
UPDATE roles
SET scopes = ARRAY(SELECT s FROM unnest(scopes) WITH ORDINALITY AS u(s, ord)
                   WHERE s <> ALL (ARRAY['billing.payments.view', 'billing.manage', 'tenant.transfer']::text[])
                   ORDER BY ord),
    updated_at = now()
WHERE code = 'admin' AND is_system
  AND scopes && ARRAY['billing.payments.view', 'billing.manage', 'tenant.transfer']::text[];
