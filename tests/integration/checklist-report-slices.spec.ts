import postgres from 'postgres'
import { afterAll, beforeAll, describe, expect, it } from 'vitest'

/**
 * ChecklistReport по мокапу (docs/31, `answers-1`): агрегаты для розрізів «По пунктах»
 * (частка виконання пункту серед усіх прогонів) і «По точках» (середній % по точці), а також
 * «По людях» на єдиному каркасі ReportFrame (docs/22 §13.3) — тут перевіряємо, що агрегати по
 * спостерігачу (кількість прогонів, середній результат) рахуються правильно.
 */
const cl = await import('../../server/services/checklists')

const admin = postgres(process.env.DATABASE_ADMIN_URL!, { max: 1, onnotice: () => {} })

let tenantId: string, adminId: string, lazarevaId: string, binaryId: string
const checklistIds: string[] = []

const ctx = () => ({ tenantId, actorId: adminId })

beforeAll(async () => {
  tenantId = (await admin`select id from tenants where slug = 'kappi'`)[0]!.id as string
  adminId = (await admin`select id from users where tenant_id = ${tenantId} and phone = '+380661864742'`)[0]!.id as string
  lazarevaId = (await admin`select id from locations where tenant_id = ${tenantId} and name = 'Лазарева'`)[0]!.id as string
  binaryId = (await admin`select id from scales where tenant_id = ${tenantId} and name = 'Зараховано / Не зараховано'`)[0]!.id as string
})

afterAll(async () => {
  if (checklistIds.length) {
    await admin`delete from checklist_runs where checklist_id in ${admin(checklistIds)}`
    await admin`delete from checklists where id in ${admin(checklistIds)}`
  }
  await admin.end()
})

describe('ChecklistReport: розрізи «По пунктах» / «По точках» / «По людях» (docs/31, docs/22 §13.3)', () => {
  it('по пунктах — частка виконання пункту; по точках — середній %; по людях — каркас + прогони', async () => {
    const r = await cl.upsertChecklist(ctx(), {
      title: `Чек-лист розрізів ${Date.now()}`,
      scaleId: binaryId,
      scoring: 'percent',
      passScore: 50,
      kind: 'observation',
      criticalFailRule: 'none',
      whoCanRun: { roles: ['admin'] },
      subjectKind: 'location',
      allowSkip: false,
      allowItemComment: false,
      itemCommentRequired: false,
      tags: [],
      items: [{ id: 'a', text: 'Пункт А', weight: 3 }, { id: 'b', text: 'Пункт Б', weight: 2 }],
    })
    if (!r.ok) throw new Error(r.code)
    const c = r.checklist
    checklistIds.push(c.id)

    // Прогін 1: А зараховано, Б — ні. (3×1+2×0)/5×100 = 60% ≥ 50 → пройдено, план дій не потрібен.
    const run1 = await cl.startRun(ctx(), c.id, { locationId: lazarevaId })
    const d1 = await cl.finishRun(ctx(), run1!.id, { answers: [{ itemId: 'a', value: 1 }, { itemId: 'b', value: 0 }] })
    expect(d1).toMatchObject({ ok: true, score: { percent: 60, passed: true } })

    // Прогін 2: А — ні, Б зараховано. (3×0+2×1)/5×100 = 40% < 50 → провал, план дій обовʼязковий.
    const run2 = await cl.startRun(ctx(), c.id, { locationId: lazarevaId })
    const d2 = await cl.finishRun(ctx(), run2!.id, {
      answers: [{ itemId: 'a', value: 0 }, { itemId: 'b', value: 1 }],
      actionPlan: [{ id: 'p1', text: 'Підтягнути пункт А', responsibleId: adminId, dueAt: '2026-12-31', status: 'open' }],
    })
    expect(d2).toMatchObject({ ok: true, score: { percent: 40, passed: false } })

    const filter = { checklistId: c.id, scope: null }

    // По пунктах: кожен пункт зараховано рівно в одному з двох прогонів → 1 з 2 = 50%
    const items = await cl.checklistItemsReport(ctx(), filter)
    const a = items.find(i => i.text === 'Пункт А')!
    const b = items.find(i => i.text === 'Пункт Б')!
    expect(a).toMatchObject({ checklist: c.title, weight: 3, total: 2, done: 1, share: '50.0' })
    expect(b).toMatchObject({ checklist: c.title, weight: 2, total: 2, done: 1, share: '50.0' })

    // По точках: середній % = (60+40)/2 = 50, обидва прогони на Лазаревій, один пройдено
    const locations = await cl.checklistLocationsReport(ctx(), filter)
    const loc = locations.find(l => l.location_id === lazarevaId)!
    expect(loc).toMatchObject({ location: 'Лазарева', runs: 2, avg_score: '50.0', passed: 1 })

    // По людях: обидва прогони — той самий спостерігач (adminId); каркас + кількість/середній результат
    const people = await cl.checklistPeopleReport(ctx(), filter)
    const me = people.find((p: Record<string, unknown>) => p.user_id === adminId)!
    expect(me).toMatchObject({ runs: 2, status: 'done', result: '50.0' })
    expect(me.full_name).toBeTruthy()

    // Фільтр по чужому чек-листу не зачіпає наші дані
    const other = await cl.checklistItemsReport(ctx(), { checklistId: crypto.randomUUID(), scope: null })
    expect(other.length).toBe(0)
  })
})
