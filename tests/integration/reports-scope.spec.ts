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

describe('docs/22: каркас, прогресс, выгрузка, журналы, дайджест', () => {
  it('previousPeriod — равный интервал непосредственно перед выбранным (§7.4)', async () => {
    const { previousPeriod } = await import('../../server/services/reportsExtra')
    expect(previousPeriod('2026-09-08', '2026-09-14')).toEqual({ from: '2026-09-01', to: '2026-09-07' })
    expect(previousPeriod('2026-09-19', '2026-09-19')).toEqual({ from: '2026-09-18', to: '2026-09-18' })
  })

  it('прогресс по предмету: воронка и разрез по контенту; плитки со сравнением; по вопросам', async () => {
    const X = await import('../../server/services/reportsExtra')
    const ctx = { tenantId, actorId: adminId }
    const [course] = await admin`insert into courses (tenant_id, title, slug, status) values (${tenantId}, ${`Курс-rep-${Date.now()}`}, ${`rep-${Date.now()}`}, 'published') returning id`
    const [ver] = await admin`insert into course_versions (tenant_id, course_id, version) values (${tenantId}, ${course!.id}, 1) returning id`
    await admin`update courses set published_version_id = ${ver!.id} where id = ${course!.id}`
    const u1 = await makePerson('Прогрес Один', lazarevaId), u2 = await makePerson('Прогрес Два', lazarevaId)
    await admin`insert into enrollments (tenant_id, user_id, subject_id, version_id, source, required_total, status, started_at, completed_at) values (${tenantId}, ${u1}, ${course!.id}, ${ver!.id}, 'self', 1, 'completed', now(), now())`
    await admin`insert into enrollments (tenant_id, user_id, subject_id, version_id, source, required_total, status) values (${tenantId}, ${u2}, ${course!.id}, ${ver!.id}, 'self', 1, 'not_started')`
    try {
      const p = await X.progress(ctx, { subject: 'course', subjectId: course!.id as string, scope: [lazarevaId] })
      expect(p.funnel).toMatchObject({ assigned: 2, started: 1, completed: 1 })
      expect(p.content[0]).toMatchObject({ subjectId: course!.id, completionPct: 50 })
      // Область видимости: чужая точка → пусто
      expect((await X.progress(ctx, { subject: 'course', subjectId: course!.id as string, scope: [] })).funnel.assigned).toBe(0)
      const t = await X.tiles(ctx, 'overdue', { from: '2026-09-01', to: '2026-09-30' })
      expect(t.previous).toEqual({ from: '2026-08-02', to: '2026-08-31' })
      expect(t).toHaveProperty('overdue.delta')
      const c = await X.content(ctx, {})
      expect(c.rows.some(r => r.id === course!.id)).toBe(true)
      const a = await X.activityExtra(ctx, {})
      expect(a.hours.length).toBe(24)
      expect(Array.isArray(await X.failedQuestions(ctx, {}))).toBe(true)
    }
    finally {
      await admin`delete from enrollments where subject_id = ${course!.id}`; await admin`update courses set published_version_id = null where id = ${course!.id}`
      await admin`delete from course_versions where id = ${ver!.id}`; await admin`delete from courses where id = ${course!.id}`
    }
  })

  it('фоновая выгрузка (§13.3): задача строит csv, ссылка живёт 24 часа, факт — в аудите', async () => {
    const { requestExport, runExport, getExport, toCsv } = await import('../../server/services/reportExports')
    const ctx = { tenantId, actorId: managerId }
    const e = await requestExport(ctx, { report: 'readiness', filters: {}, format: 'csv' })
    expect(e.status).toBe('queued')
    await runExport(e.id, tenantId)
    const r = await getExport(ctx, e.id)
    expect(r!.status).toBe('ready')
    expect(r!.url).toMatch(/^http/)
    expect(r!.expiresAt!.getTime()).toBeGreaterThan(Date.now() + 23 * 3_600_000)
    const [n] = await admin`select count(*)::int as c from notifications where user_id = ${managerId} and code = 'report_export_ready'`
    expect(n!.c).toBe(1)
    const [audit] = await admin`select count(*)::int as c from audit_log where tenant_id = ${tenantId} and action = 'report.export' and entity_id = ${e.id}`
    expect(audit!.c).toBe(1)
    expect(toCsv([{ a: 1, b: 'x;y' }]).toString('utf-8')).toContain('"x;y"')
    // Чужую выгрузку не видно
    expect(await getExport({ tenantId, actorId: unitManagerId }, e.id)).toBeNull()
    await admin`delete from report_exports where id = ${e.id}`
  })

  it('журналы (§5): единый вход с фильтрами; очистка по срокам хранения', async () => {
    const { readLog, retentionScan, LOG_KINDS } = await import('../../server/services/logs')
    const ctx = { tenantId, actorId: adminId }
    for (const k of LOG_KINDS) expect(Array.isArray(await readLog(ctx, k, { limit: 5 }))).toBe(true)
    const sec = await readLog(ctx, 'security', { userId: managerId })
    expect(sec.every(r => r.user_id === managerId)).toBe(true)
    await admin`insert into notifications (tenant_id, user_id, code, channel, payload, status, created_at) values (${tenantId}, ${managerId}, 'old_one', 'telegram', '{}', 'sent', now() - interval '400 days')`
    const r = await retentionScan(tenantId)
    expect(r.notifications).toBeGreaterThanOrEqual(1)
    const [left] = await admin`select count(*)::int as c from notifications where user_id = ${managerId} and code = 'old_one'`
    expect(left!.c).toBe(0)
  })

  it('недельный дайджест руководителю точки (§8)', async () => {
    const { weeklyDigest } = await import('../../server/services/reportsExtra')
    await admin`update locations set manager_id = ${managerId} where id = ${lazarevaId}`
    try {
      expect(await weeklyDigest(tenantId)).toBeGreaterThanOrEqual(1)
      const [n] = await admin`select payload from notifications where user_id = ${managerId} and code = 'weekly_digest' order by created_at desc limit 1`
      expect(n!.payload).toHaveProperty('overdue')
      expect(await weeklyDigest(tenantId)).toBe(0) // дедуп по неделе
    }
    finally { await admin`update locations set manager_id = null where id = ${lazarevaId}` }
  })
})
