import postgres from 'postgres'
import { afterAll, beforeAll, describe, expect, it } from 'vitest'

/**
 * Блок «Сквозное» (docs/v2/46, cross-cutting-tails; решения — docs/v2/44 §18):
 *
 * - **Р-CC.1** — новое объявление платформы приходит администраторам адресованного тенанта в
 *   колокольчик; не адресованный тенант, черновик и повтор задачи не дают ничего.
 * - **Р-CC.2** — `oauth.states_cleanup` удаляет state, истёкшие больше суток назад, и только
 *   своего тенанта (уборщик работает внутри `withTenant()`).
 */

const PA = await import('../../server/services/platformAnnouncements')
const { cleanupStates } = await import('../../server/services/oauth')

const admin = postgres(process.env.DATABASE_ADMIN_URL!, { max: 2, onnotice: () => {} })

const MARK = 'cross-cutting тест'
const OTHER_SLUG = 'v2-cc-other'
let tenantId: string
let otherTenantId: string
let adminId: string
let employeeId: string
let op: { adminId: string, email: string, fullName: string }

async function cleanup() {
  const ids = (await admin`select id from platform_announcements where title like ${`${MARK}%`}`).map(r => r.id as string)
  if (ids.length) {
    await admin`delete from notifications where code = ${PA.ANNOUNCEMENT_NOTIFY_CODE} and payload->>'title' like ${`${MARK}%`}`
    await admin`delete from platform_announcements where id in ${admin(ids)}`
  }
  await admin`delete from oauth_states where provider = 'google' and state_hash like 'cc-test-%'`
}

beforeAll(async () => {
  tenantId = (await admin`select id from tenants where slug = 'kappi'`)[0]!.id as string
  adminId = (await admin`select id from users where tenant_id = ${tenantId} and phone = '+380661864742'`)[0]!.id as string
  // Сотрудник без роли администратора — объявление Lola ему не приходит
  employeeId = (await admin`
    select u.id from users u where u.tenant_id = ${tenantId} and u.kind = 'employee' and u.status = 'active'
      and not exists (select 1 from user_roles ur join roles r on r.id = ur.role_id where ur.user_id = u.id and r.code in ('admin', 'owner'))
    limit 1`)[0]!.id as string
  const [o] = await admin`insert into tenants (slug, name, plan) values (${OTHER_SLUG}, 'CC: інший простір', 'network') on conflict (slug) do update set plan = 'network' returning id`
  otherTenantId = o!.id as string
  const [p] = await admin`insert into platform_admins (email, full_name, password_hash) values ('v2-cc-ops@lola.test', 'Оператор CC', 'x') on conflict (email) do update set full_name = excluded.full_name returning id`
  op = { adminId: p!.id as string, email: 'v2-cc-ops@lola.test', fullName: 'Оператор CC' }
  await cleanup()
})

afterAll(async () => {
  await cleanup()
  await admin`delete from platform_admins where email = 'v2-cc-ops@lola.test'`
  await admin`delete from tenants where id = ${otherTenantId}`
  await admin.end()
})

const inbox = (announcementTitle: string) => admin`
  select user_id, channel, payload from notifications
  where tenant_id = ${tenantId} and code = ${PA.ANNOUNCEMENT_NOTIFY_CODE} and payload->>'title' = ${announcementTitle}`

describe('Р-CC.1: уведомление о новом объявлении платформы', () => {
  it('адресованному тенанту — администраторам в колокольчик, сотруднику — нет; повтор задачи не дублирует', async () => {
    const title = `${MARK}: усім`
    const r = await PA.createAnnouncement(op, { title, body: 'Текст', audience: 'all', planCodes: [], tenantIds: [], publish: true })
    expect(r.ok).toBe(true)
    const id = (r as { id: string }).id
    const n = await PA.notifyAnnouncementTenant(tenantId, id)
    expect(n).toBeGreaterThan(0)
    const rows = await inbox(title)
    expect(rows.map(x => x.user_id)).toContain(adminId)
    expect(rows.map(x => x.user_id)).not.toContain(employeeId)
    expect(rows.every(x => x.channel === 'inapp')).toBe(true)
    expect(rows[0]!.payload).toMatchObject({ url: '/admin/platform-announcements' })
    // Повтор задачи (ретрай pg-boss) — ключ дедупликации на объявление и человека
    expect(await PA.notifyAnnouncementTenant(tenantId, id)).toBe(0)
    expect((await inbox(title)).length).toBe(rows.length)
  })

  it('не адресованный тенант, черновик и снятое — ничего; публикация черновика — рассылка', async () => {
    const other = await PA.createAnnouncement(op, { title: `${MARK}: іншому`, body: 'x', audience: 'tenants', planCodes: [], tenantIds: [otherTenantId], publish: true })
    expect(await PA.notifyAnnouncementTenant(tenantId, (other as { id: string }).id)).toBe(0)
    expect((await inbox(`${MARK}: іншому`)).length).toBe(0)

    const draft = await PA.createAnnouncement(op, { title: `${MARK}: чернетка`, body: 'x', audience: 'all', planCodes: [], tenantIds: [], publish: false })
    const draftId = (draft as { id: string }).id
    expect(await PA.notifyAnnouncementTenant(tenantId, draftId)).toBe(0)
    expect((await PA.publishAnnouncement(op, draftId)).ok).toBe(true)
    expect(await PA.notifyAnnouncementTenant(tenantId, draftId)).toBeGreaterThan(0)

    const gone = await PA.createAnnouncement(op, { title: `${MARK}: знято`, body: 'x', audience: 'all', planCodes: [], tenantIds: [], publish: true })
    const goneId = (gone as { id: string }).id
    await PA.archiveAnnouncement(op, goneId)
    expect(await PA.notifyAnnouncementTenant(tenantId, goneId)).toBe(0)
    expect(await PA.notifyAnnouncementTenant(tenantId, 'не-uuid')).toBe(0)
  })

  it('по тарифу — только тенанту с этим тарифом', async () => {
    const [{ plan }] = await admin`select plan from tenants where id = ${tenantId}` as unknown as [{ plan: string }]
    const otherPlan = plan === 'network' ? 'point' : 'network'
    const r = await PA.createAnnouncement(op, { title: `${MARK}: тариф`, body: 'x', audience: 'plans', planCodes: [otherPlan], tenantIds: [], publish: true })
    expect(r.ok).toBe(true)
    expect(await PA.notifyAnnouncementTenant(tenantId, (r as { id: string }).id)).toBe(0)
    const mine = await PA.createAnnouncement(op, { title: `${MARK}: мій тариф`, body: 'x', audience: 'plans', planCodes: [plan], tenantIds: [], publish: true })
    expect(await PA.notifyAnnouncementTenant(tenantId, (mine as { id: string }).id)).toBeGreaterThan(0)
  })
})

describe('Р-CC.2: oauth.states_cleanup', () => {
  it('удаляет истёкшие больше суток назад, свежие и чужого тенанта не трогает', async () => {
    const now = new Date()
    const h = (n: number) => new Date(now.getTime() - n * 3600_000)
    await admin`insert into oauth_states (tenant_id, provider, state_hash, expires_at, consumed_at) values
      (${tenantId}, 'google', 'cc-test-old', ${h(30)}, null),
      (${tenantId}, 'google', 'cc-test-old-used', ${h(25)}, ${h(25.1)}),
      (${tenantId}, 'google', 'cc-test-recent', ${h(2)}, null),
      (${tenantId}, 'google', 'cc-test-live', ${new Date(now.getTime() + 600_000)}, null),
      (${otherTenantId}, 'google', 'cc-test-other-old', ${h(30)}, null)`
    expect(await cleanupStates(tenantId, now)).toBe(2)
    const left = (await admin`select state_hash from oauth_states where state_hash like 'cc-test-%' order by state_hash`).map(r => r.state_hash)
    expect(left).toEqual(['cc-test-live', 'cc-test-other-old', 'cc-test-recent'])
    expect(await cleanupStates(otherTenantId, now)).toBe(1)
  })
})
