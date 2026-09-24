import postgres from 'postgres'
import { afterAll, beforeAll, describe, expect, it } from 'vitest'

/**
 * PR-39 пакета `docs/v2` (`45-plan.md`): настройки тенанта и платформы.
 *
 * - **Две «новости» не смешаны** (условие выхода; патч П-21): объявления платформы пишет только
 *   оператор, тенант читает их отдельной лентой по адресации; новости компании в неё не попадают,
 *   объявления — в новости; сессия тенанта не может записать объявление даже ошибкой кода.
 * - **«Посада → курси за замовчуванням»** (П-24.3) — правило `automation_rules` с измерением
 *   `position`, привязанное к должности или **группе должностей** (П-24.5); отдельной таблицы нет.
 * - **Нормы отпуска** (П-24.1, `docs/v2/38` §3.6, §7.13): компания → точка → человек → дефолт.
 * - **Колонтитул с логотипом** (П-24.1): логотип — только своё фирменное изображение.
 */

process.env.ENCRYPTION_KEY ??= 'test-encryption-key'

const PA = await import('../../server/services/platformAnnouncements')
const { platformAnnouncements, platformAnnouncementReads } = await import('../../server/db/schema')
const { withTenant } = await import('../../server/utils/withTenant')
const { listNews } = await import('../../server/services/news')
const PD = await import('../../server/services/positionDefaults')
const { updateRef, deleteRef } = await import('../../server/services/refs')
const { runRules, updateRule, deleteRule, RuleBoundToPositionError } = await import('../../server/services/automation')
const AN = await import('../../server/services/absenceNorms')
const { updateTenantSpace, tenantSpace, tenantSettings } = await import('../../server/services/settings')

const admin = postgres(process.env.DATABASE_ADMIN_URL!, { max: 2, onnotice: () => {} })

const MARK = 'PR-39 тест'
const OTHER_SLUG = 'v2-39-other'
const PHONES = ['+380679391001', '+380679391002']
let tenantId: string
let otherTenantId: string
let adminId: string
let otherUserId: string
let placedUserId: string
let op: { adminId: string, email: string, fullName: string }
let ctx: { tenantId: string, actorId: string }
let courseIds: string[]
let locationIds: string[]

async function cleanup() {
  await admin`delete from platform_announcements where title like ${`${MARK}%`}`
  await admin`delete from news where title like ${`${MARK}%`}`
  await admin`delete from automation_rules where tenant_id = ${tenantId} and (position_id is not null or position_group_id is not null)`
  await admin`update positions set group_id = null where tenant_id = ${tenantId}`
  await admin`delete from position_groups where name like ${`${MARK}%`}`
  await admin`delete from absence_norms where year in (2031, 2032)`
  await admin`delete from media_assets where original_name like ${`${MARK}%`}`
  const ids = (await admin`select id from users where phone in ${admin(PHONES)}`).map(r => r.id as string)
  if (ids.length) {
    await admin`delete from user_placements where user_id in ${admin(ids)}`
    await admin`delete from audit_log where entity_id in ${admin(ids)}`
    await admin`delete from users where id in ${admin(ids)}`
  }
}

beforeAll(async () => {
  tenantId = (await admin`select id from tenants where slug = 'kappi'`)[0]!.id as string
  adminId = (await admin`select id from users where tenant_id = ${tenantId} and phone = '+380661864742'`)[0]!.id as string
  ctx = { tenantId, actorId: adminId }
  const [o] = await admin`insert into tenants (slug, name, plan) values (${OTHER_SLUG}, 'PR-39: інший простір', 'network') on conflict (slug) do update set plan = 'network' returning id`
  otherTenantId = o!.id as string
  await cleanup()
  const [u] = await admin`insert into users (tenant_id, phone, full_name, status, kind) values (${otherTenantId}, ${PHONES[0]!}, 'PR-39 Інший', 'invited', 'employee') returning id`
  otherUserId = u!.id as string
  const [p] = await admin`insert into platform_admins (email, full_name, password_hash) values ('v2-39-ops@lola.test', 'Оператор PR-39', 'x') on conflict (email) do update set full_name = excluded.full_name returning id`
  op = { adminId: p!.id as string, email: 'v2-39-ops@lola.test', fullName: 'Оператор PR-39' }
  courseIds = (await admin`select id from courses where tenant_id = ${tenantId} and status <> 'archived' order by title limit 2`).map(r => r.id as string)
  locationIds = (await admin`select id from locations where tenant_id = ${tenantId} order by name`).map(r => r.id as string)
})

afterAll(async () => {
  await cleanup()
  await admin.end()
})

// ── Две «новости» (П-21, условие выхода PR-39) ─────────────────────────────────────────

describe('объявления платформы — вторая «новость», отдельная от ленты компании', () => {
  const ids: Record<string, string> = {}

  async function create(key: string, input: Partial<Parameters<typeof PA.createAnnouncement>[1]>) {
    const r = await PA.createAnnouncement(op, { title: `${MARK}: ${key}`, body: `Текст ${key}`, audience: 'all', planCodes: [], tenantIds: [], publish: true, ...input })
    if (!r.ok) throw new Error(r.code)
    ids[key] = r.id
  }

  it('сессия тенанта не может записать объявление платформы: у app_user нет insert/update/delete', async () => {
    const tryInsert = withTenant(tenantId, adminId, tx => tx.insert(platformAnnouncements).values({ title: `${MARK}: самозванець`, body: 'x' }))
    await expect(tryInsert).rejects.toThrow(/permission denied/)
    await expect(withTenant(tenantId, adminId, tx => tx.update(platformAnnouncements).set({ title: 'x' }))).rejects.toThrow(/permission denied/)
    await expect(withTenant(tenantId, adminId, tx => tx.delete(platformAnnouncements))).rejects.toThrow(/permission denied/)
    // Читать — можно: лента тенанта идёт обычной ролью приложения
    await expect(withTenant(tenantId, adminId, tx => tx.select({ id: platformAnnouncements.id }).from(platformAnnouncements).limit(1))).resolves.toBeDefined()
  })

  it('оператор: адресация всем / по тарифу / пространствам, черновик и снятое не видны', async () => {
    await create('всім', {})
    await create('Каппі', { audience: 'tenants', tenantIds: [tenantId] })
    await create('тариф network', { audience: 'plans', planCodes: ['network'] })
    await create('чернетка', { publish: false })
    await create('знято', {})
    expect((await PA.archiveAnnouncement(op, ids['знято']!)).ok).toBe(true)

    const mine = (await PA.tenantFeed(ctx)).items.map(i => i.title)
    expect(mine).toEqual(expect.arrayContaining([`${MARK}: всім`, `${MARK}: Каппі`]))
    expect(mine).not.toContain(`${MARK}: тариф network`) // у «Каппі» тариф trial
    expect(mine).not.toContain(`${MARK}: чернетка`)
    expect(mine).not.toContain(`${MARK}: знято`)

    const theirs = (await PA.tenantFeed({ tenantId: otherTenantId, actorId: otherUserId })).items.map(i => i.title)
    expect(theirs).toEqual(expect.arrayContaining([`${MARK}: всім`, `${MARK}: тариф network`]))
    expect(theirs).not.toContain(`${MARK}: Каппі`) // адресовано чужому пространству

    // Наружу — только текст и даты: адресация и списки пространств тенанту не отдаются
    const one = (await PA.tenantFeed(ctx)).items.find(i => i.id === ids['Каппі'])!
    expect(Object.keys(one).sort()).toEqual(['body', 'id', 'publishedAt', 'read', 'title'])
  })

  it('«прочитано»: своё — отмечается, чужое адресное — 404, отметки одного пространства не видны другому', async () => {
    expect(await PA.markRead(ctx, ids['Каппі']!)).toBe('ok')
    expect(await PA.markRead(ctx, ids['Каппі']!)).toBe('ok') // повтор — без ошибки и дубля
    expect(await PA.markRead({ tenantId: otherTenantId, actorId: otherUserId }, ids['Каппі']!)).toBe('not_found')
    expect(await PA.markRead(ctx, ids['чернетка']!)).toBe('not_found')
    expect(await PA.markRead(ctx, 'не-uuid')).toBe('not_found')

    const feed = await PA.tenantFeed(ctx)
    expect(feed.items.find(i => i.id === ids['Каппі'])?.read).toBe(true)
    expect(feed.items.find(i => i.id === ids['всім'])?.read).toBe(false)
    expect(feed.unread).toBe(feed.items.filter(i => !i.read).length)

    expect(await PA.markRead({ tenantId: otherTenantId, actorId: otherUserId }, ids['всім']!)).toBe('ok')
    const seenFromKappi = await withTenant(tenantId, adminId, tx => tx.select().from(platformAnnouncementReads))
    expect(seenFromKappi.every(r => r.tenantId === tenantId)).toBe(true)
    const list = await PA.listForOperator()
    expect(list.find(a => a.id === ids['всім'])?.readers).toBeGreaterThanOrEqual(1)
  })

  it('две ленты не смешиваются: новость компании не в ленте платформы, объявление — не в новостях', async () => {
    await admin`insert into news (tenant_id, title, status, published_at) values (${tenantId}, ${`${MARK}: новина компанії`}, 'published', now())`
    const platformTitles = (await PA.tenantFeed(ctx)).items.map(i => i.title)
    expect(platformTitles).not.toContain(`${MARK}: новина компанії`)
    const newsTitles = (await listNews(ctx)).map(n => n.title)
    expect(newsTitles).toContain(`${MARK}: новина компанії`)
    expect(newsTitles.filter(t => t.startsWith(`${MARK}:`) && t !== `${MARK}: новина компанії`)).toEqual([])
  })

  it('оператор: тариф из справочника, снятое не правится, публикация черновика — один раз', async () => {
    const bad = await PA.createAnnouncement(op, { title: `${MARK}: хибний`, body: 'x', audience: 'plans', planCodes: ['platinum'], tenantIds: [], publish: true })
    expect(bad).toEqual({ ok: false, code: 'unknown_plan' })
    expect(await PA.updateAnnouncement(op, ids['знято']!, { title: `${MARK}: інше` })).toEqual({ ok: false, code: 'archived' })
    expect(await PA.publishAnnouncement(op, ids['чернетка']!)).toEqual({ ok: true })
    const titles = (await PA.tenantFeed(ctx)).items.map(i => i.title)
    expect(titles).toContain(`${MARK}: чернетка`)
    expect(await PA.updateAnnouncement(op, '00000000-0000-0000-0000-000000000000', { title: `${MARK}: немає` })).toEqual({ ok: false, code: 'not_found' })
    const [audit] = await admin`select count(*)::int as n from platform_audit where action like 'announcement.%' and admin_id = ${op.adminId}`
    expect(audit!.n).toBeGreaterThanOrEqual(6)
  })
})

// ── Группы должностей и курсы по умолчанию (П-24.3, П-24.5) ─────────────────────────────

describe('«посада → курси за замовчуванням» — правило автоматизации, привязанное к должности или группе', () => {
  let groupId: string
  let p1: string, p2: string

  beforeAll(async () => {
    const pos = await admin`select id from positions where tenant_id = ${tenantId} order by name limit 2`
    p1 = pos[0]!.id as string
    p2 = pos[1]!.id as string
    const [g] = await admin`insert into position_groups (tenant_id, name, sort_order) values (${tenantId}, ${`${MARK}: кухня`}, 1) returning id`
    groupId = g!.id as string
    const [u] = await admin`insert into users (tenant_id, phone, full_name, status, kind) values (${tenantId}, ${PHONES[1]!}, 'PR-39 Кухар', 'invited', 'employee') returning id`
    placedUserId = u!.id as string
    await admin`insert into user_placements (tenant_id, user_id, location_id, position_id, is_primary) values (${tenantId}, ${placedUserId}, ${locationIds[0]!}, ${p1}, true)`
  })

  it('курсы группе — одно правило: триггер найма/перевода, измерение position = состав группы', async () => {
    expect(await updateRef(ctx, 'positions', p1, { groupId })).not.toBeNull()
    const r = await PD.setDefaultCourses(ctx, { kind: 'group', id: groupId }, [{ courseId: courseIds[0]!, dueDays: 7 }])
    expect(r.ok).toBe(true)
    const [rule] = await admin`select id, trigger, is_active, position_group_id, actions from automation_rules where position_group_id = ${groupId}`
    expect(rule).toMatchObject({ trigger: 'user.placement_changed', is_active: true })
    expect(rule!.actions).toEqual([{ type: 'assign_content', subjectType: 'course', subjectId: courseIds[0]!, dueDays: 7 }])
    const [dim] = await admin`select mode, value_ids from automation_rule_dimensions where rule_id = ${rule!.id} and dimension = 'position'`
    expect(dim).toMatchObject({ mode: 'include', value_ids: [p1] })
    // Отдельной таблицы связи нет — ровно правило и его измерения
    expect((await admin`select 1 from information_schema.tables where table_name in ('position_courses', 'position_default_courses')`).length).toBe(0)
  })

  it('должность вошла в группу — аудитория правила группы пересобрана в той же правке', async () => {
    await updateRef(ctx, 'positions', p2, { groupId })
    const [dim] = await admin`select value_ids from automation_rule_dimensions d join automation_rules r on r.id = d.rule_id where r.position_group_id = ${groupId} and d.dimension = 'position'`
    expect([...(dim!.value_ids as string[])].sort()).toEqual([p1, p2].sort())
  })

  it('курсы должности плюс курсы её группы — `effective` для окна найма, без повторов', async () => {
    const r = await PD.setDefaultCourses(ctx, { kind: 'position', id: p1 }, [{ courseId: courseIds[1]!, dueDays: 14 }, { courseId: courseIds[0]!, dueDays: 3 }])
    expect(r.ok).toBe(true)
    const d = (await PD.getDefaultCourses(ctx, { kind: 'position', id: p1 }))!
    expect(d.items.map(i => i.courseId)).toEqual([courseIds[1]!, courseIds[0]!])
    expect(d.group?.items.map(i => i.courseId)).toEqual([courseIds[0]!])
    // Курс и в должности, и в группе — один раз, со сроком должности
    expect(d.effective).toEqual([
      expect.objectContaining({ courseId: courseIds[1]!, dueDays: 14 }),
      expect.objectContaining({ courseId: courseIds[0]!, dueDays: 3 }),
    ])
  })

  it('движок правил без изменений: найм на должность срабатывает оба правила — должности и группы', async () => {
    const results = await runRules(tenantId, 'user.placement_changed', placedUserId, {}, { dryRun: true })
    const mine = await admin`select id from automation_rules where position_id = ${p1} or position_group_id = ${groupId}`
    const byRule = new Map(results.map(r => [r.ruleId, r]))
    for (const r of mine) {
      expect(byRule.get(r.id as string)?.status, `правило ${r.id}`).toBe('ok')
      expect(byRule.get(r.id as string)?.actions.length).toBeGreaterThan(0)
    }
  })

  it('общий редактор правил привязанное правило не меняет и не удаляет — 409', async () => {
    const [rule] = await admin`select id from automation_rules where position_group_id = ${groupId}`
    await expect(updateRule(ctx, rule!.id as string, { name: 'підміна' })).rejects.toBeInstanceOf(RuleBoundToPositionError)
    await expect(deleteRule(ctx, rule!.id as string)).rejects.toBeInstanceOf(RuleBoundToPositionError)
  })

  it('чужой курс, архивный курс, чужая должность — отказ; чужая группа должности не ставится', async () => {
    expect(await PD.setDefaultCourses(ctx, { kind: 'position', id: p1 }, [{ courseId: '00000000-0000-0000-0000-000000000000', dueDays: 7 }]))
      .toEqual({ ok: false, code: 'course_not_found', courseIds: ['00000000-0000-0000-0000-000000000000'] })
    expect(await PD.getDefaultCourses({ tenantId: otherTenantId, actorId: otherUserId }, { kind: 'position', id: p1 })).toBeNull()
    expect(await PD.setDefaultCourses({ tenantId: otherTenantId, actorId: otherUserId }, { kind: 'group', id: groupId }, [])).toEqual({ ok: false, code: 'not_found' })
    const [foreign] = await admin`insert into position_groups (tenant_id, name) values (${otherTenantId}, ${`${MARK}: чужа`}) returning id`
    expect(await updateRef(ctx, 'positions', p1, { groupId: foreign!.id as string })).toBeNull()
    const [pos] = await admin`select group_id from positions where id = ${p1}`
    expect(pos!.group_id).toBe(groupId)
  })

  it('непустую группу не удалить; опустевшая группа выключает своё правило — иначе оно назначило бы курсы всем', async () => {
    expect(await deleteRef(ctx, 'position-groups', groupId)).toMatchObject({ ok: false, code: 'in_use' })
    await updateRef(ctx, 'positions', p1, { groupId: null })
    await updateRef(ctx, 'positions', p2, { groupId: null })
    const [rule] = await admin`select id, is_active from automation_rules where position_group_id = ${groupId}`
    expect(rule!.is_active).toBe(false)
    expect((await admin`select 1 from automation_rule_dimensions where rule_id = ${rule!.id} and array_length(value_ids, 1) > 0`).length).toBe(0)
  })

  it('пустой список курсов должности выключает её правило, но не удаляет (назначенное остаётся у людей)', async () => {
    const r = await PD.setDefaultCourses(ctx, { kind: 'position', id: p1 }, [])
    expect(r.ok && r.defaults.items).toEqual([])
    const [rule] = await admin`select is_active, actions from automation_rules where position_id = ${p1}`
    expect(rule).toMatchObject({ is_active: false, actions: [] })
  })
})

// ── Нормы отпуска (П-24.1, `38` §3.6, §7.13) ────────────────────────────────────────────

describe('нормы отсутствий: компания → точка → человек → системный дефолт', () => {
  it('`38` §13 к.9: компания 24, точка переопределила только больничный (7) — 24 «компании» и 7 «точки»', async () => {
    await AN.putAbsenceNorm(ctx, { scopeType: 'tenant', scopeId: null, year: 2031, vacationDays: 24, sickDays: 5 })
    await AN.putAbsenceNorm(ctx, { scopeType: 'location', scopeId: locationIds[0]!, year: 2031, sickDays: 7 })
    const r = await withTenant(tenantId, adminId, tx => AN.resolveAbsenceNorms(tx, { year: 2031, userId: placedUserId }))
    expect(r).toEqual({ vacation: { value: 24, source: 'tenant' }, sick: { value: 7, source: 'location' } })
  })

  it('ничего не задано — системный дефолт 24 / 5', async () => {
    const r = await withTenant(tenantId, adminId, tx => AN.resolveAbsenceNorms(tx, { year: 2032, locationId: locationIds[0]! }))
    expect(r).toEqual({ vacation: { value: 24, source: 'system' }, sick: { value: 5, source: 'system' } })
  })

  it('индивидуальная корректировка — с причиной, побеждает точку и компанию; без причины БД не примет', async () => {
    await AN.putAbsenceNorm(ctx, { scopeType: 'user', scopeId: placedUserId, year: 2031, vacationDays: 26.5, reason: 'Стаж понад 10 років' })
    const r = await withTenant(tenantId, adminId, tx => AN.resolveAbsenceNorms(tx, { year: 2031, userId: placedUserId }))
    expect(r.vacation).toEqual({ value: 26.5, source: 'user' })
    expect(r.sick).toEqual({ value: 7, source: 'location' })
    await expect(admin`insert into absence_norms (tenant_id, scope_type, scope_id, year, vacation_days) values (${tenantId}, 'user', ${placedUserId}, 2032, 10)`).rejects.toThrow(/absence_norms_reason_chk/)
  })

  it('строка компании на год одна (nulls not distinct); оба null снимают переопределение точки', async () => {
    await expect(admin`insert into absence_norms (tenant_id, scope_type, scope_id, year, vacation_days) values (${tenantId}, 'tenant', null, 2031, 20)`).rejects.toThrow(/uq_absence_norms_scope_year/)
    await AN.putAbsenceNorm(ctx, { scopeType: 'location', scopeId: locationIds[0]!, year: 2031, vacationDays: null, sickDays: null })
    expect((await admin`select 1 from absence_norms where scope_type = 'location' and year = 2031 and scope_id = ${locationIds[0]!}`).length).toBe(0)
    const r = await withTenant(tenantId, adminId, tx => AN.resolveAbsenceNorms(tx, { year: 2031, locationId: locationIds[0]! }))
    expect(r.sick).toEqual({ value: 5, source: 'tenant' })
    const [audit] = await admin`select count(*)::int as n from audit_log where action = 'absence_norm.set' and actor_id = ${adminId}`
    expect(audit!.n).toBeGreaterThanOrEqual(3)
  })

  it('обзор блока настроек: норма компании и точки области права', async () => {
    await AN.putAbsenceNorm(ctx, { scopeType: 'location', scopeId: locationIds[0]!, year: 2031, sickDays: 7 })
    const all = await AN.absenceNormsOverview(ctx, 2031, null)
    expect(all.tenant).toEqual({ vacationDays: 24, sickDays: 5 })
    expect(all.locations.find(l => l.locationId === locationIds[0])).toMatchObject({ vacationDays: null, sickDays: 7 })
    const narrow = await AN.absenceNormsOverview(ctx, 2031, [locationIds[1]!])
    expect(narrow.locations.map(l => l.locationId)).toEqual([locationIds[1]!])
    const none = await AN.absenceNormsOverview(ctx, 2031, [])
    expect(none.locations).toEqual([])
  })

  it('чужая точка и чужой человек — не найдены (404), кандидат норм отпуска не имеет', async () => {
    expect(await AN.normTargetLocation({ tenantId: otherTenantId, actorId: otherUserId }, { scopeType: 'location', scopeId: locationIds[0]! })).toEqual({ found: false, locationId: null })
    expect(await AN.normTargetLocation(ctx, { scopeType: 'user', scopeId: otherUserId })).toEqual({ found: false, locationId: null })
    expect(await AN.normTargetLocation(ctx, { scopeType: 'user', scopeId: placedUserId })).toEqual({ found: true, locationId: locationIds[0]! })
    const [cand] = await admin`select id from users where tenant_id = ${tenantId} and kind = 'candidate' limit 1`
    if (cand) expect((await AN.normTargetLocation(ctx, { scopeType: 'user', scopeId: cand.id as string })).found).toBe(false)
  })
})

// ── Колонтитул с логотипом (П-24.1) ──────────────────────────────────────────────────────

describe('колонтитул с логотипом в материалах', () => {
  it('логотип — только своё фирменное изображение; колонтитул выключен по умолчанию и включается', async () => {
    const before = await tenantSettings(ctx)
    expect(before.space.contentFooter).toBe(false)
    const [other] = await admin`insert into media_assets (tenant_id, key, original_name, kind, mime, bytes, status, origin) values (${tenantId}, 'pr39/x.png', ${`${MARK}: обкладинка`}, 'image', 'image/png', 10, 'ready', 'content_cover') returning id`
    const [logo] = await admin`insert into media_assets (tenant_id, key, original_name, kind, mime, bytes, status, origin) values (${tenantId}, 'pr39/logo.png', ${`${MARK}: логотип`}, 'image', 'image/png', 10, 'ready', 'brand_asset') returning id`
    const [foreign] = await admin`insert into media_assets (tenant_id, key, original_name, kind, mime, bytes, status, origin) values (${otherTenantId}, 'pr39/f.png', ${`${MARK}: чужий`}, 'image', 'image/png', 10, 'ready', 'brand_asset') returning id`
    expect(await updateTenantSpace(ctx, { logoMediaId: other!.id as string })).toEqual({ ok: false, code: 'logo_invalid' })
    expect(await updateTenantSpace(ctx, { logoMediaId: foreign!.id as string })).toEqual({ ok: false, code: 'logo_invalid' })
    const ok = await updateTenantSpace(ctx, { logoMediaId: logo!.id as string, space: { contentFooter: true } })
    expect(ok.ok).toBe(true)
    expect((await tenantSpace(ctx)).logoMediaId).toBe(logo!.id)
    expect((await tenantSettings(ctx)).space.contentFooter).toBe(true)
    // Вернуть как было — общий тенант «Каппі» делят все тесты
    const back = await updateTenantSpace(ctx, { logoMediaId: null, space: { contentFooter: false } })
    expect(back.ok).toBe(true)
    expect((await tenantSpace(ctx)).logoMediaId).toBeNull()
  })
})
