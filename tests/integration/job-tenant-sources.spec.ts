import postgres from 'postgres'
import { sql } from 'drizzle-orm'
import { afterAll, beforeAll, describe, expect, it } from 'vitest'

/**
 * Источники тенантов для кругов фоновых задач (docs/25 §5, docs/28 «Очередь») — под ролью приложения.
 *
 * `notification.dispatch`, `attempt.expire` и `webhook.deliver` обходят только тенантов «с работой».
 * До 24.09.2026 список строился `select distinct tenant_id from <таблица>` с общего соединения без
 * `app.tenant_id`: под RLS это ноль строк, и круг не обслуживал никого — уведомления стояли в
 * `queued`, попытки не закрывались, вебхуки не уходили. Тесты этого не видели: каждая проверка
 * круга передавала `runPerTenant` готовый список тенантов, а сами источники не вызывались ни разу.
 *
 * Здесь источники зовутся так же, как их зовёт воркер, — общим соединением `db` (роль из
 * `DATABASE_URL`). Первая проверка требует, чтобы это была роль без обхода RLS: под
 * суперпользователем остальные прошли бы и на сломанном коде.
 */

const { db } = await import('../../server/db/client')
const { dispatchNotifications, tenantsWithQueued } = await import('../../server/services/notifications')
const { tenantsWithActiveAttempts } = await import('../../server/services/attempts')
const { tenantsWithPendingWebhooks } = await import('../../server/services/webhooks')
const { resetRoundRobin, runPerTenant } = await import('../../server/services/tenantQueue')

const admin = postgres(process.env.DATABASE_ADMIN_URL!, { max: 1, onnotice: () => {} })
const stamp = Date.now().toString(36)

interface Fixture { id: string, userId: string, quizId: string, endpointId: string }
const created: Fixture[] = []
let busyA: Fixture, busyB: Fixture, idle: Fixture

async function makeTenant(label: string): Promise<Fixture> {
  const [t] = await admin`insert into tenants (slug, name, status) values (${`jobs-${label}-${stamp}`}, ${`Фонові задачі ${label}`}, 'active') returning id`
  const id = t!.id as string
  const [u] = await admin`insert into users (tenant_id, full_name, status) values (${id}, ${`Учень ${label}`}, 'active') returning id`
  const [q] = await admin`insert into quizzes (tenant_id, title, status) values (${id}, ${`Тест ${label}`}, 'published') returning id`
  const [e] = await admin`
    insert into webhook_endpoints (tenant_id, url, secret_encrypted, nonce, events)
    values (${id}, 'http://127.0.0.1:9/hook', decode('00', 'hex'), decode('00', 'hex'), array['attempt.passed'])
    returning id`
  const f = { id, userId: u!.id as string, quizId: q!.id as string, endpointId: e!.id as string }
  created.push(f)
  return f
}

/** Работа, срок которой наступил: уведомление в очереди, попытка в процессе, доставка вебхука. */
async function addDueWork(f: Fixture) {
  await admin`insert into notifications (tenant_id, user_id, code, channel, payload, status, scheduled_for)
    values (${f.id}, ${f.userId}, 'manual', 'inapp', '{"text":"due"}', 'queued', now() - interval '1 minute')`
  await admin`insert into attempts (tenant_id, quiz_id, user_id, attempt_no, snapshot, params, status, started_at)
    values (${f.id}, ${f.quizId}, ${f.userId}, 1, '[]', '{}', 'in_progress', now())`
  await admin`insert into webhook_deliveries (tenant_id, endpoint_id, event, payload, status, next_attempt_at)
    values (${f.id}, ${f.endpointId}, 'attempt.passed', '{}', 'pending', now() - interval '1 minute')`
}

/** Строки, которые работой не являются: срок ещё не наступил либо всё уже сделано. */
async function addNotDueWork(f: Fixture) {
  await admin`insert into notifications (tenant_id, user_id, code, channel, payload, status, scheduled_for)
    values (${f.id}, ${f.userId}, 'manual', 'inapp', '{"text":"later"}', 'queued', now() + interval '1 day')`
  await admin`insert into notifications (tenant_id, user_id, code, channel, payload, status, scheduled_for, sent_at)
    values (${f.id}, ${f.userId}, 'manual', 'inapp', '{"text":"done"}', 'sent', now() - interval '1 day', now() - interval '1 day')`
  await admin`insert into attempts (tenant_id, quiz_id, user_id, attempt_no, snapshot, params, status, started_at, submitted_at)
    values (${f.id}, ${f.quizId}, ${f.userId}, 1, '[]', '{}', 'passed', now() - interval '1 hour', now())`
  await admin`insert into webhook_deliveries (tenant_id, endpoint_id, event, payload, status, next_attempt_at)
    values (${f.id}, ${f.endpointId}, 'attempt.passed', '{}', 'pending', now() + interval '1 hour')`
  await admin`insert into webhook_deliveries (tenant_id, endpoint_id, event, payload, status, next_attempt_at, delivered_at)
    values (${f.id}, ${f.endpointId}, 'attempt.passed', '{}', 'delivered', now() - interval '1 hour', now() - interval '1 hour')`
}

beforeAll(async () => {
  busyA = await makeTenant('a')
  busyB = await makeTenant('b')
  idle = await makeTenant('idle')
  await addDueWork(busyA)
  await addDueWork(busyB)
  await addNotDueWork(idle)
})

afterAll(async () => {
  const ids = created.map(f => f.id)
  if (ids.length) {
    await admin`delete from webhook_deliveries where tenant_id in ${admin(ids)}`
    await admin`delete from webhook_endpoints where tenant_id in ${admin(ids)}`
    await admin`delete from notifications where tenant_id in ${admin(ids)}`
    await admin`delete from attempts where tenant_id in ${admin(ids)}`
    await admin`delete from quizzes where tenant_id in ${admin(ids)}`
    await admin`delete from users where tenant_id in ${admin(ids)}`
    await admin`delete from tenants where id in ${admin(ids)}`
  }
  await admin.end()
})

describe('источники кругов фоновых задач — под ролью приложения', () => {
  it('общее соединение — роль без обхода RLS: без контекста тенанта строк не видно', async () => {
    const [role] = await db.execute(sql`
      select current_user as name, r.rolsuper as super, r.rolbypassrls as bypass
      from pg_roles r where r.rolname = current_user`) as unknown as { name: string, super: boolean, bypass: boolean }[]
    expect(role, `DATABASE_URL должен указывать на app_user (см. .env.example), сейчас ${role?.name}: под ролью с обходом RLS проверки ниже ничего не доказывают`)
      .toMatchObject({ super: false, bypass: false })
    // Та самая ловушка прежнего запроса: работа есть, но без app.tenant_id её не видно
    const [seen] = await db.execute(sql`select count(*)::int as n from notifications where tenant_id in (${busyA.id}, ${busyB.id})`) as unknown as { n: number }[]
    expect(seen!.n).toBe(0)
  })

  it('notification.dispatch: tenantsWithQueued() видит оба тенанта с уведомлениями к отправке', async () => {
    const ids = await tenantsWithQueued()
    expect(ids).toEqual(expect.arrayContaining([busyA.id, busyB.id]))
    expect(ids).not.toContain(idle.id) // только отложенное и уже отправленное
  })

  it('attempt.expire: tenantsWithActiveAttempts() видит оба тенанта с попытками в процессе', async () => {
    const ids = await tenantsWithActiveAttempts()
    expect(ids).toEqual(expect.arrayContaining([busyA.id, busyB.id]))
    expect(ids).not.toContain(idle.id) // только завершённая попытка
  })

  it('webhook.deliver: tenantsWithPendingWebhooks() видит оба тенанта с доставками, чей срок наступил', async () => {
    const ids = await tenantsWithPendingWebhooks()
    expect(ids).toEqual(expect.arrayContaining([busyA.id, busyB.id]))
    expect(ids).not.toContain(idle.id) // только повтор в будущем и уже доставленное
  })

  it('круг notification.dispatch с настоящим источником разбирает очередь обоих тенантов', async () => {
    resetRoundRobin()
    // Источник — тот же, что у воркера; круг ограничен тенантами этого файла, чтобы не
    // разбирать очередь чужих тенантов общей тестовой базы.
    const mine = new Set(created.map(f => f.id))
    const round = await runPerTenant('notification.dispatch', (tenantId, quota) => dispatchNotifications(tenantId, quota),
      async () => (await tenantsWithQueued()).filter(id => mine.has(id)))
    expect(round.order.sort()).toEqual([busyA.id, busyB.id].sort())
    expect(round.done).toBe(2)
    const left = await admin`select tenant_id from notifications
      where tenant_id in (${busyA.id}, ${busyB.id}) and status = 'queued' and scheduled_for <= now()`
    expect(left).toEqual([])
  })
})
