import postgres from 'postgres'
import { afterAll, beforeAll, describe, expect, it } from 'vitest'

/**
 * PR debts-5 (docs/33): D-022 (orgStructure.mode=user_groups в rebuildOrgGroups), D-023
 * (manager_external_id при імпорті), D-025 (programs.code/icon_key/workload), D-037 (свій поріг
 * пункта чек-листа), D-038 («Дублювати новою версією» замороженої анкети).
 */

const G = await import('../../server/services/groups')
const { validateImport, applyImport } = await import('../../server/services/importPeople')
const { updatePolicies } = await import('../../server/services/settings')
const Pr = await import('../../server/services/programs')
const { scoreRun } = await import('../../server/services/checklists')
const As = await import('../../server/services/assessment')

const admin = postgres(process.env.DATABASE_ADMIN_URL!, { max: 1, onnotice: () => {} })

let tenantId: string, adminId: string, posId: string
let unitId: string, locId: string
let originalSettings: unknown
const PHONE_PREFIX = '+38091'
const userIds: string[] = []
const programIds: string[] = []
const formIds: string[] = []
const groupIds: string[] = []
const ctx = () => ({ tenantId, actorId: adminId })

beforeAll(async () => {
  tenantId = (await admin`select id from tenants where slug = 'kappi'`)[0]!.id as string
  adminId = (await admin`select id from users where tenant_id = ${tenantId} and phone = '+380661864742'`)[0]!.id as string
  originalSettings = (await admin`select settings from tenants where id = ${tenantId}`)[0]!.settings
  posId = (await admin`insert into positions (tenant_id, name) values (${tenantId}, ${`Посада-d5-${Date.now()}`}) returning id`)[0]!.id as string
  const [kappiUnit] = await admin`select id from org_units where tenant_id = ${tenantId} and name = 'Каппі'`
  unitId = (await admin`insert into org_units (tenant_id, name, path, parent_id) values (${tenantId}, ${`Цех-d5-${Date.now()}`}, ${`kappi.d5_${Date.now()}`}, ${kappiUnit!.id}) returning id`)[0]!.id as string
  locId = (await admin`insert into locations (tenant_id, name, org_unit_id) values (${tenantId}, ${`Точка-d5-${Date.now()}`}, ${unitId}) returning id`)[0]!.id as string
})

afterAll(async () => {
  await admin`update tenants set settings = ${admin.json(originalSettings as never)} where id = ${tenantId}`
  if (programIds.length) await admin`delete from programs where id in ${admin(programIds)}`
  if (formIds.length) await admin`delete from assessment_forms where id in ${admin(formIds)}`
  if (groupIds.length) await admin`delete from criteria_groups where id in ${admin(groupIds)}`
  const imported = await admin`select id from users where tenant_id = ${tenantId} and (phone like ${`${PHONE_PREFIX}%`} or external_id like 'D5-%')`
  const ids = [...new Set([...userIds, ...imported.map(r => r.id as string)])]
  if (ids.length) await admin`delete from users where id in ${admin(ids)}`
  await admin`delete from import_jobs where tenant_id = ${tenantId} and file_name like 'd5-%'`
  await admin`delete from user_groups where tenant_id = ${tenantId} and (org_unit_id = ${unitId} or location_id = ${locId})`
  await admin`delete from locations where id = ${locId}`
  await admin`delete from org_units where id = ${unitId}`
  await admin`delete from positions where id = ${posId}`
  await admin.end()
})

describe('D-022: rebuildOrgGroups учитывает orgStructure.mode (docs/16 §14.3, docs/33)', () => {
  it('mode=hybrid строит производную группу, mode=user_groups её снимает и новые не строит', async () => {
    await updatePolicies(ctx(), { orgStructure: { mode: 'hybrid' } })
    await G.rebuildOrgGroups(tenantId)
    const [group] = await admin`select * from user_groups where tenant_id = ${tenantId} and org_unit_id = ${unitId}`
    expect(group).toBeTruthy()
    expect(group!.is_org_derived).toBe(true)

    await updatePolicies(ctx(), { orgStructure: { mode: 'user_groups' } })
    const removed = await G.rebuildOrgGroups(tenantId)
    expect(removed).toBeGreaterThan(0)
    const after = await admin`select * from user_groups where tenant_id = ${tenantId} and org_unit_id = ${unitId}`
    expect(after.length).toBe(0)
  })
})

describe('D-023: manager_external_id при імпорті — лінійний керівник за зовнішнім № (docs/16 §15 Г-16.1, docs/33)', () => {
  const row = (ext: string, extra: Record<string, string> = {}) => ({
    'Зовнішній ID': ext, 'Прізвище': 'Імпорт', 'Імʼя': ext, 'Телефон': `${PHONE_PREFIX}${String(Math.floor(Math.random() * 1e7)).padStart(7, '0')}`,
    'Посада': 'Бариста', 'Підрозділ': 'Каппі', 'Точка': 'Лазарева', ...extra,
  })

  it('керівник, зустрінутий у файлі, резолвиться у manager_id основного розміщення підлеглого', async () => {
    const boss = 'D5-BOSS'
    const sub = 'D5-SUB'
    // Керівник іде в файлі ПІСЛЯ підлеглого — резолв повинен спрацювати незалежно від порядку
    const v = await validateImport(ctx(), 'd5-a.csv', [row(sub, { 'Керівник (зовнішній ID)': boss }), row(boss)])
    expect((v.rows[0]!.warnings ?? []).some(w => w.includes('не знайдено'))).toBe(false)
    await applyImport(ctx(), v.jobId)
    const [subUser] = await admin`select id from users where tenant_id = ${tenantId} and external_id = ${sub}`
    const [bossUser] = await admin`select id from users where tenant_id = ${tenantId} and external_id = ${boss}`
    const [placement] = await admin`select manager_id from user_placements where user_id = ${subUser!.id} and is_primary and ended_at is null`
    expect(placement!.manager_id).toBe(bossUser!.id)
  })

  it('власний зовнішній ID як керівник — помилка валідації; невідомий керівник — попередження, рядок не блокується', async () => {
    const self = 'D5-SELF'
    const vSelf = await validateImport(ctx(), 'd5-b.csv', [row(self, { 'Керівник (зовнішній ID)': self })])
    expect(vSelf.rows[0]!.errors.some(e => e.includes('Керівник'))).toBe(true)
    expect(vSelf.rows[0]!.action).toBe('skip')

    const unknown = 'D5-UNKNOWN-MGR'
    const vUnknown = await validateImport(ctx(), 'd5-c.csv', [row('D5-HASBOSS', { 'Керівник (зовнішній ID)': unknown })])
    expect(vUnknown.rows[0]!.errors).toHaveLength(0)
    expect((vUnknown.rows[0]!.warnings ?? []).some(w => w.includes('не знайдено'))).toBe(true)
    await applyImport(ctx(), vUnknown.jobId)
    const [u] = await admin`select id from users where tenant_id = ${tenantId} and external_id = 'D5-HASBOSS'`
    expect(u).toBeTruthy()
  })
})

describe('D-025: programs.code/icon_key/workload (docs/17 отк. (2), docs/33)', () => {
  it('поля сохраняются и выводятся в listPrograms/getProgram', async () => {
    const p = await Pr.createProgram(ctx(), { title: `Програма D5 ${Date.now()}` })
    programIds.push(p.id)
    await Pr.updateProgram(ctx(), p.id, { code: 'PRG-D5', iconKey: 'star', workload: '2 год/тиждень' })
    const got = await Pr.getProgram(ctx(), p.id)
    expect(got).toMatchObject({ code: 'PRG-D5', iconKey: 'star', workload: '2 год/тиждень' })
    const list = await Pr.listPrograms(ctx(), { all: true }) as { id: string, code: string | null }[]
    expect(list.find(r => r.id === p.id)?.code).toBe('PRG-D5')
  })
})

describe('D-037: свій поріг пункта чек-листа (docs/20 отк. (3), docs/33)', () => {
  const scale = { id: 's', name: 'shkala', options: [], min: 0, max: 10 }
  const items = (passThreshold?: number) => [{ id: 'i1', text: 'Пункт', weight: 1, passThreshold }]
  it('пункт зі своїм порогом провалюється по ньому, а не по прохідному балу чек-листа', async () => {
    // Значення 8 з 10 → частка 80%. Прохідний бал чек-листа 50 (пройшло б), свій поріг пункта 90 (провал)
    const withOwn = scoreRun({ items: items(90), scoring: 'percent', passScore: 50, criticalFailRule: 'none' }, [{ itemId: 'i1', value: 8 }], scale)
    expect(withOwn.failedItems).toEqual(['i1'])
    const withoutOwn = scoreRun({ items: items(undefined), scoring: 'percent', passScore: 50, criticalFailRule: 'none' }, [{ itemId: 'i1', value: 8 }], scale)
    expect(withoutOwn.failedItems).toEqual([])
  })
})

describe('D-038: «Дублювати новою версією» замороженої анкети (docs/20 §14.4, docs/33)', () => {
  it('дублікат — новий id, розблокований, з тим самим складом; is_locked не переноситься', async () => {
    const g = await As.upsertGroup(ctx(), { name: `Група D5 ${Date.now()}`, weight: 1, tags: [] })
    groupIds.push(g!.id)
    const c1 = await As.upsertCriterion(ctx(), { groupId: g!.id, text: 'Критерій D5' })
    const [scaleRow] = await admin`select id from scales where tenant_id = ${tenantId} and name = '1–5'`
    const r = await As.saveForm(ctx(), {
      title: `Анкета D5 ${Date.now()}`, scaleId: scaleRow!.id as string, kind: 'by_criteria', allowCommentGroups: false, commentGroupsRequired: false,
      commentWhenAboveNorm: false, commentWhenBelowNorm: true, commentWhenEqual: false, zeroMeansNoGrade: false, tags: [], isActive: true,
      items: [{ criterionId: c1!.id, norm: 3 }],
    })
    if (!r.ok) throw new Error(r.code)
    formIds.push(r.form.id)
    await admin`update assessment_forms set is_locked = true where id = ${r.form.id}`

    const dup = await As.duplicateForm(ctx(), r.form.id)
    expect(dup).toBeTruthy()
    formIds.push(dup!.id)
    expect(dup!.id).not.toBe(r.form.id)
    expect(dup!.isLocked).toBe(false)
    const items = await admin`select criterion_id, norm from assessment_items where form_id = ${dup!.id}`
    expect(items).toHaveLength(1)
    expect(items[0]!.criterion_id).toBe(c1!.id)
  })
})
