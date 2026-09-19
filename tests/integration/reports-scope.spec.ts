import postgres from 'postgres'
import { afterAll, beforeAll, describe, expect, it } from 'vitest'

const { loadAccess, reportScope, narrowScope } = await import('../../server/services/access')
const R = await import('../../server/services/reports')
const { staffingReport } = await import('../../server/services/people')
const { checklistReport } = await import('../../server/services/checklists')
const { runReport } = await import('../../server/services/reportBuilder')

/** docs/22 §2, §7.1, §13.1: руководитель точки Лазарева не видит другие точки ни фильтром, ни напрямую. */
const admin = postgres(process.env.DATABASE_ADMIN_URL!, { max: 1, onnotice: () => {} })
let tenantId: string, adminId: string, lazarevaId: string, segedskaId: string, managerId: string, unitManagerId: string, posId: string
const userIds: string[] = []

async function makePerson(name: string, locationId: string) {
  const phone = `+38098${String(Math.floor(Math.random() * 1e7)).padStart(7, '0')}`
  const [u] = await admin`insert into users (tenant_id, phone, full_name, status) values (${tenantId}, ${phone}, ${name}, 'active') returning id`
  userIds.push(u!.id as string)
  await admin`insert into user_placements (tenant_id, user_id, location_id, position_id, is_primary) values (${tenantId}, ${u!.id}, ${locationId}, ${posId}, true)`
  return u!.id as string
}

beforeAll(async () => {
  tenantId = (await admin`select id from tenants where slug = 'kappi'`)[0]!.id as string
  adminId = (await admin`select id from users where tenant_id = ${tenantId} and phone = '+380661864742'`)[0]!.id as string
  lazarevaId = (await admin`select id from locations where tenant_id = ${tenantId} and name = 'Лазарева'`)[0]!.id as string
  segedskaId = (await admin`select id from locations where tenant_id = ${tenantId} and name = 'Сегедська'`)[0]!.id as string
  posId = (await admin`insert into positions (tenant_id, name, code) values (${tenantId}, ${`Бариста-scope-${Date.now()}`}, 'barista-scope') returning id`)[0]!.id as string
  managerId = await makePerson('Керуючий Лазарева Тест', lazarevaId)
  await admin`insert into user_roles (tenant_id, user_id, role_id, scope_type, scope_id) select ${tenantId}, ${managerId}, id, 'location', ${lazarevaId} from roles where tenant_id = ${tenantId} and code = 'manager'`
  // Руководитель подразделения, в которое входит Сегедська
  const [unit] = await admin`select org_unit_id from locations where id = ${segedskaId}`
  unitManagerId = await makePerson('Керівник Підрозділу Тест', segedskaId)
  await admin`insert into user_roles (tenant_id, user_id, role_id, scope_type, scope_id) select ${tenantId}, ${unitManagerId}, id, 'org_unit', ${unit!.org_unit_id} from roles where tenant_id = ${tenantId} and code = 'manager'`
  await makePerson('Бариста Сегедська Тест', segedskaId)
})
afterAll(async () => {
  if (userIds.length) { await admin`delete from user_roles where user_id in ${admin(userIds)}`; await admin`delete from users where id in ${admin(userIds)}` }
  await admin`delete from positions where id = ${posId}`
  await admin.end()
})

describe('область видимости отчётов (docs/22 §13.1)', () => {
  it('роль на точке → область = эта точка; фильтр другой точкой сужает до пустого; администратор видит всё', async () => {
    const mgr = (await loadAccess({ sessionId: 's', tenantId, userId: managerId, impersonatedBy: null } as never))!
    const scope = await reportScope(mgr)
    expect(scope).toEqual([lazarevaId])
    expect(narrowScope(scope, segedskaId)).toEqual([])
    expect(narrowScope(scope, lazarevaId)).toEqual([lazarevaId])
    const adm = (await loadAccess({ sessionId: 's', tenantId, userId: adminId, impersonatedBy: null } as never))!
    expect(await reportScope(adm)).toBeNull()
    expect(narrowScope(null, segedskaId)).toEqual([segedskaId])
  })

  it('роль на подразделении раскрывается в его точки', async () => {
    const um = (await loadAccess({ sessionId: 's', tenantId, userId: unitManagerId, impersonatedBy: null } as never))!
    const scope = await reportScope(um)
    expect(scope).toContain(segedskaId)
  })

  it('готовность, штат, чек-листы, конструктор — только своя точка; чужая точка фильтром → пусто', async () => {
    const ctx = { tenantId, actorId: managerId }
    const own = await R.readiness(ctx, { scope: [lazarevaId] })
    expect(own.length).toBeGreaterThan(0)
    expect(own.every(r => r.location === 'Лазарева')).toBe(true)
    expect(await R.readiness(ctx, { scope: [] })).toEqual([])
    const staff = await staffingReport(ctx, undefined, [lazarevaId])
    expect(staff.every(r => r.location === 'Лазарева')).toBe(true)
    const cl = await checklistReport(ctx, { scope: [lazarevaId] })
    expect(cl.runs.every(r => r.location === 'Лазарева' || r.location === null)).toBe(true)
    const rows = await runReport(ctx, { entity: 'people', fields: ['full_name', 'location'], filters: {}, groupBy: null }, 500, [lazarevaId])
    expect(rows.length).toBeGreaterThan(0)
    expect(rows.every(r => r.location === 'Лазарева')).toBe(true)
    expect(rows.some(r => r.full_name === 'Бариста Сегедська Тест')).toBe(false)
    // Прямой запрос с чужой точкой: область пуста → ничего
    expect(await runReport(ctx, { entity: 'people', fields: ['full_name'], filters: { location_id: segedskaId }, groupBy: null }, 500, narrowScope([lazarevaId], segedskaId))).toEqual([])
  })
})
