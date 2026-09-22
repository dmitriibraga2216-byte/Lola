import postgres from 'postgres'
import { afterAll, beforeAll, describe, expect, it } from 'vitest'

const P = await import('../../server/services/people')
const G = await import('../../server/services/groups')
const { guessMapping, validateImport, applyImport, getImportJob } = await import('../../server/services/importPeople')
const { resolveAudience } = await import('../../server/services/audience')
const { orgTree } = await import('../../server/services/orgTree')
const { publicCertificate } = await import('../../server/services/certificates')
const { withTenant } = await import('../../server/utils/withTenant')
const R = await import('../../server/services/refs')

const admin = postgres(process.env.DATABASE_ADMIN_URL!, { max: 1, onnotice: () => {} })
let tenantId: string, adminId: string, lazarevaId: string, segedskaId: string, posId: string, courseId: string, versionId: string, quizId: string
const userIds: string[] = []
const groupIds: string[] = []
const PHONE_PREFIX = '+38097'
const ctx = () => ({ tenantId, actorId: adminId })

async function makePerson(name: string, opts: { locationId?: string, startedAt?: string, hidden?: boolean } = {}) {
  const phone = `${PHONE_PREFIX}${String(Math.floor(Math.random() * 1e7)).padStart(7, '0')}`
  const [u] = await admin`insert into users (tenant_id, phone, full_name, status, hired_at, is_hidden) values (${tenantId}, ${phone}, ${name}, 'active', current_date - 100, ${opts.hidden ?? false}) returning id`
  const id = u!.id as string
  userIds.push(id)
  await admin`insert into user_placements (tenant_id, user_id, location_id, position_id, is_primary, started_at) values (${tenantId}, ${id}, ${opts.locationId ?? lazarevaId}, ${posId}, true, ${opts.startedAt ?? new Date().toISOString().slice(0, 10)})`
  return id
}

beforeAll(async () => {
  tenantId = (await admin`select id from tenants where slug = 'kappi'`)[0]!.id as string
  adminId = (await admin`select id from users where tenant_id = ${tenantId} and phone = '+380661864742'`)[0]!.id as string
  lazarevaId = (await admin`select id from locations where tenant_id = ${tenantId} and name = 'Лазарева'`)[0]!.id as string
  segedskaId = (await admin`select id from locations where tenant_id = ${tenantId} and name = 'Сегедська'`)[0]!.id as string
  posId = (await admin`insert into positions (tenant_id, name, code) values (${tenantId}, ${`Бариста-people-${Date.now()}`}, 'barista-people') returning id`)[0]!.id as string
  // Свой курс с версией и тест: в CI сид без опубликованного контента
  courseId = (await admin`insert into courses (tenant_id, title, slug, status) values (${tenantId}, ${`Курс-people-${Date.now()}`}, ${`people-${Date.now()}`}, 'published') returning id`)[0]!.id as string
  versionId = (await admin`insert into course_versions (tenant_id, course_id, version) values (${tenantId}, ${courseId}, 1) returning id`)[0]!.id as string
  await admin`update courses set published_version_id = ${versionId} where id = ${courseId}`
  quizId = (await admin`insert into quizzes (tenant_id, title, status) values (${tenantId}, ${`Тест-people-${Date.now()}`}, 'published') returning id`)[0]!.id as string
})
afterAll(async () => {
  if (groupIds.length) await admin`delete from user_groups where id in ${admin(groupIds)}`
  await admin`delete from import_jobs where tenant_id = ${tenantId} and file_name like 'people-spec%'`
  const imported = await admin`select id from users where tenant_id = ${tenantId} and (phone like ${`${PHONE_PREFIX}%`} or external_id like 'PS-%')`
  const ids = [...new Set([...userIds, ...imported.map(r => r.id as string)])]
  if (ids.length) {
    await admin`delete from notifications where user_id in ${admin(ids)}`
    await admin`delete from attempts where user_id in ${admin(ids)}`
    await admin`delete from certificates where user_id in ${admin(ids)}`
    await admin`delete from enrollments where user_id in ${admin(ids)}`
    await admin`delete from user_notes where user_id in ${admin(ids)}`
    await admin`delete from functional_chiefs where user_id in ${admin(ids)} or chief_id in ${admin(ids)}`
    await admin`delete from users where id in ${admin(ids)}`
  }
  await admin`delete from positions where id = ${posId}`
  await admin`delete from quizzes where id = ${quizId}`
  await admin`update courses set published_version_id = null where id = ${courseId}`
  await admin`delete from course_versions where id = ${versionId}`
  await admin`delete from courses where id = ${courseId}`
  await admin.end()
})

describe('люди (docs/16 §13)', () => {
  it('screens-7 (docs/31 `People`): счётчики чипів Активні · Заблоковані · Усі рахуються по тим самим фільтрам, крім вкладки', async () => {
    const marker = `Лічильник-${Date.now()}`
    const activeId = await makePerson(`${marker}-Активний`)
    const blockedId = await makePerson(`${marker}-Блок`)
    await admin`update users set status = 'suspended' where id = ${blockedId}`
    const before = await P.listPeople(ctx(), { q: marker, tab: 'all', limit: 10 })
    expect(before.counts).toEqual({ active: 1, blocked: 1, all: 2 })
    // Вкладка не влияет на счётчики — фільтр «пошук» той самий
    const onActiveTab = await P.listPeople(ctx(), { q: marker, tab: 'active', limit: 10 })
    expect(onActiveTab.counts).toEqual({ active: 1, blocked: 1, all: 2 })
    expect(onActiveTab.items.map(i => i.id)).toEqual([activeId])
  })

  it('§13.2: переведённый с точки А на Б в отчёте за прошлый месяц показан на А', async () => {
    const id = await makePerson('Перевід Тест', { locationId: lazarevaId, startedAt: '2026-06-01' })
    await P.addPlacement(ctx(), id, { locationId: segedskaId, positionId: posId, isPrimary: true, startedAt: '2026-09-10' })
    const before = await P.placementAt(ctx(), id, '2026-08-15')
    const now = await P.placementAt(ctx(), id, '2026-09-15')
    expect(before?.location).toBe('Лазарева')
    expect(now?.location).toBe('Сегедська')
    const staffing = await P.staffingReport(ctx(), '2026-08-15')
    const lazRow = staffing.find(r => r.location === 'Лазарева' && r.position.startsWith('Бариста-people'))
    expect(lazRow?.people).toBe(1)
    expect(staffing.find(r => r.location === 'Сегедська' && r.position.startsWith('Бариста-people'))).toBeUndefined()
  })

  it('§13.3: единственного администратора нельзя лишить роли, заблокировать или архивировать', async () => {
    const [cnt] = await admin`select count(*)::int as n from user_roles ur join roles r on r.id = ur.role_id where r.tenant_id = ${tenantId} and r.code = 'admin' and ur.scope_type = 'tenant'`
    expect(cnt!.n).toBe(1)
    expect(await P.removeRole(ctx(), adminId, 'admin')).toEqual({ ok: false, code: 'last_admin' })
    expect(await P.setBlocked(ctx(), adminId, true)).toEqual({ ok: false, code: 'last_admin' })
    expect(await P.archivePerson(ctx(), adminId, { reason: 'mistake' })).toEqual({ ok: false, code: 'last_admin' })
    expect(await P.updatePerson(ctx(), adminId, { status: 'archived' })).toEqual({ lastAdmin: true })
    // Второй админ снимает ограничение
    const second = await makePerson('Другий Адмін')
    await P.assignRole(ctx(), second, { roleCode: 'admin', scopeType: 'tenant' })
    expect(await P.removeRole(ctx(), second, 'admin')).toEqual({ ok: true })
  })

  it('§13.4: архив закрывает сессии, снимает обучение, сертификат остаётся по публичной ссылке', async () => {
    const id = await makePerson('Архів Тест')
    await admin`insert into sessions (tenant_id, user_id, token_hash, expires_at) values (${tenantId}, ${id}, ${`h-${id}`}, now() + interval '1 day')`
    await admin`insert into enrollments (tenant_id, user_id, subject_id, version_id, source, required_total, status) values (${tenantId}, ${id}, ${courseId}, ${versionId}, 'self', 1, 'in_progress')`
    const [cert] = await admin`insert into certificates (tenant_id, user_id, course_id, number, score, issued_at, public_token) values (${tenantId}, ${id}, ${courseId}, ${`PS-${Date.now()}`}, 90, now(), ${`tok-${id}`}) returning public_token`
    const r = await P.archivePerson(ctx(), id, { reason: 'dismissal', comment: 'тест' })
    expect(r).toMatchObject({ ok: true, cancelled: 1 })
    const [s] = await admin`select revoked_at from sessions where user_id = ${id}`
    expect(s!.revoked_at).not.toBeNull()
    const [e] = await admin`select cancelled_at from enrollments where user_id = ${id}`
    expect(e!.cancelled_at).not.toBeNull()
    const [pl] = await admin`select ended_at from user_placements where user_id = ${id}`
    expect(pl!.ended_at).not.toBeNull()
    const pub = await publicCertificate(cert!.public_token as string)
    expect(pub).not.toBeNull()
    // Блокировка (docs/16 §7.4) обучение не снимает
    const id2 = await makePerson('Блок Тест')
    await admin`insert into enrollments (tenant_id, user_id, subject_id, version_id, source, required_total, status) values (${tenantId}, ${id2}, ${courseId}, ${versionId}, 'self', 1, 'in_progress')`
    expect(await P.setBlocked(ctx(), id2, true)).toEqual({ ok: true })
    const [e2] = await admin`select status from enrollments where user_id = ${id2}`
    expect(e2!.status).toBe('in_progress')
    const [u2] = await admin`select is_blocked, status from users where id = ${id2}`
    expect(u2).toMatchObject({ is_blocked: true, status: 'suspended' })
  })

  it('§13.5: скрытый не попадает в аудиторию и оргструктуру, но виден админу в списке', async () => {
    const hidden = await makePerson('Прихований Тест', { hidden: true })
    const aud = await withTenant(tenantId, adminId, tx => resolveAudience(tx, { rules: [{ type: 'user', ids: [hidden] }], match: 'any' }))
    expect(aud.has(hidden)).toBe(false)
    const tree = await orgTree(ctx())
    const names = JSON.stringify(tree)
    expect(names.includes('Прихований Тест')).toBe(false)
    const listed = await P.listPeople(ctx(), { q: 'Прихований', tab: 'all', limit: 10 })
    expect(listed.items.length).toBe(0)
    const listedHidden = await P.listPeople(ctx(), { q: 'Прихований', tab: 'all', limit: 10, includeHidden: true })
    expect(listedHidden.items.some(p => p.id === hidden)).toBe(true)
  })

  it('§13.6: слияние дублей переносит попытки и сертификаты, дубль помечен «Обʼєднано»', async () => {
    const primary = await makePerson('Основний Дубль')
    const dup = await makePerson('Другий Дубль')
    await admin`insert into certificates (tenant_id, user_id, course_id, number, score, issued_at, public_token) values (${tenantId}, ${dup}, ${courseId}, ${`PS-D-${Date.now()}`}, 80, now(), ${`tok-d-${dup}`})`
    await admin`insert into attempts (tenant_id, quiz_id, user_id, attempt_no, snapshot, params, status, started_at) values (${tenantId}, ${quizId}, ${dup}, 1, '{}', '{}', 'submitted', now())`
    const r = await P.mergePeople(ctx(), primary, dup)
    expect(r.ok).toBe(true)
    const [c] = await admin`select count(*)::int as n from certificates where user_id = ${primary}`
    const [a] = await admin`select count(*)::int as n from attempts where user_id = ${primary}`
    expect(c!.n).toBe(1)
    expect(a!.n).toBe(1)
    const [d] = await admin`select status, comment, phone from users where id = ${dup}`
    expect(d!.status).toBe('archived')
    expect(String(d!.comment)).toContain('Обʼєднано з Основний Дубль')
    expect(d!.phone).toBeNull()
  })

  it('§5.4: сопоставление колонок угадывается по синонимам; строка без телефона с external_id принимается как invited', async () => {
    const mapping = guessMapping(['Full name', 'Phone', 'Position', 'Department', 'Location', 'External ID'])
    expect(mapping).toEqual({ 'Full name': 'ПІБ', 'Phone': 'Телефон', 'Position': 'Посада', 'Department': 'Підрозділ', 'Location': 'Точка', 'External ID': 'Зовнішній ID' })
    const raw = [
      { 'Full name': 'Імпорт Мапінг', 'Phone': `${PHONE_PREFIX}1000001`, 'Position': 'Бариста', 'Department': 'Каппі', 'Location': 'Лазарева', 'External ID': 'PS-M1' },
      { 'Full name': 'Без Телефону', 'Phone': '', 'Position': 'Бариста', 'Department': 'Каппі', 'Location': 'Лазарева', 'External ID': 'PS-M2' },
      { 'Full name': 'Без Нічого', 'Phone': '', 'Position': 'Бариста', 'Department': 'Каппі', 'Location': 'Лазарева', 'External ID': '' },
    ]
    const v = await validateImport(ctx(), 'people-spec.csv', raw)
    expect(v.mapping).toEqual(mapping)
    expect(v.stats).toMatchObject({ total: 3, create: 2, skip: 1, errors: 1, warnings: 1 })
    expect(v.rows[1]!.warnings![0]).toContain('Телефон')
    expect(v.rows[2]!.errors[0]).toContain('Телефон')
    await applyImport(ctx(), v.jobId)
    const job = await getImportJob(ctx(), v.jobId)
    expect(job!.status).toBe('applied')
    expect(job!.finishedAt).not.toBeNull()
    const [u] = await admin`select status, phone from users where external_id = 'PS-M2' and tenant_id = ${tenantId}`
    expect(u).toMatchObject({ status: 'invited', phone: null })
    // Пресет сохранился — при следующем импорте применяется автоматически
    const { remapImport, listMappingPresets } = await import('../../server/services/importPeople')
    const v2 = await validateImport(ctx(), 'people-spec-2.csv', raw)
    await remapImport(ctx(), v2.jobId, { mapping, options: { createRefs: false } })
    expect((await listMappingPresets(ctx())).default).toEqual(mapping)
  })

  it('§3.4–3.5: динамическая группа пересчитывается; функциональный руководитель; заметки', async () => {
    const a = await makePerson('Група Один')
    const b = await makePerson('Група Два')
    const g = await G.upsertGroup(ctx(), { name: `Тест-група ${Date.now()}`, kind: 'dynamic', filter: { positionIds: [posId] } }) as { id: string, members: string[] }
    groupIds.push(g!.id)
    expect(g!.members).toEqual(expect.arrayContaining([a, b]))
    const c = await makePerson('Група Три')
    await G.recalcGroups(tenantId)
    const [gg] = await admin`select members from user_groups where id = ${g!.id}`
    expect(gg!.members).toContain(c)
    const aud = await withTenant(tenantId, adminId, tx => resolveAudience(tx, { rules: [{ type: 'group', ids: [g!.id] }], match: 'any' }))
    expect(aud.has(c)).toBe(true)

    expect(await P.setChief(ctx(), { userId: a, chiefId: a, kind: 'functional' })).toBeNull()
    const chief = await P.setChief(ctx(), { userId: a, chiefId: b, kind: 'functional', scope: 'якість' })
    expect(chief!.chiefId).toBe(b)
    const chiefs = await P.listChiefs(ctx(), a)
    expect(chiefs.length).toBe(1)
    expect(await P.removeChief(ctx(), chief!.id)).toBe(true)

    await P.addNote(ctx(), a, 'Перша нотатка')
    const notes = await P.listNotes(ctx(), a)
    expect(notes[0]).toMatchObject({ body: 'Перша нотатка' })
  })

  it('§3.3: справочники — переименование, перенос подразделения с пересчётом пути, удаление используемого запрещено, слияние', async () => {
    const stamp = Date.now()
    const [root] = await admin`insert into org_units (tenant_id, name, path) values (${tenantId}, ${`Корінь-${stamp}`}, ${`root_${stamp}`}) returning id, path`
    const [child] = await admin`insert into org_units (tenant_id, name, parent_id, path) values (${tenantId}, ${`Дитя-${stamp}`}, ${root!.id}, ${`root_${stamp}.child_${stamp}`}) returning id`
    const [other] = await admin`insert into org_units (tenant_id, name, path) values (${tenantId}, ${`Інший-${stamp}`}, ${`other_${stamp}`}) returning id`
    try {
      const renamed = await R.updateRef(ctx(), 'org-units', child!.id as string, { name: `Дитя2-${stamp}` })
      expect(renamed?.name).toBe(`Дитя2-${stamp}`)
      // Перенос child под other → путь other.child
      expect(await R.updateRef(ctx(), 'org-units', child!.id as string, { parentId: other!.id })).not.toBeNull()
      const [moved] = await admin`select path::text, parent_id from org_units where id = ${child!.id}`
      expect(moved!.path).toBe(`other_${stamp}.child_${stamp}`)
      expect(moved!.parent_id).toBe(other!.id)
      // Цикл: other под child — отказ
      expect(await R.updateRef(ctx(), 'org-units', other!.id as string, { parentId: child!.id })).toBeNull()
      // Удалить other нельзя — у него дочерний узел
      expect(await R.deleteRef(ctx(), 'org-units', other!.id as string)).toMatchObject({ ok: false, code: 'in_use' })
      expect(await R.deleteRef(ctx(), 'org-units', child!.id as string)).toEqual({ ok: true })
      expect(await R.deleteRef(ctx(), 'org-units', other!.id as string)).toEqual({ ok: true })
      // Слияние городов: пользователь переезжает в целевой город, источник удалён
      const [c1] = await admin`insert into cities (tenant_id, name) values (${tenantId}, ${`Місто-А-${stamp}`}) returning id`
      const [c2] = await admin`insert into cities (tenant_id, name) values (${tenantId}, ${`Місто-Б-${stamp}`}) returning id`
      const uid = await makePerson('Містянин Тест')
      await admin`update users set city_id = ${c1!.id} where id = ${uid}`
      const m = await R.mergeRefs(ctx(), 'cities', c1!.id as string, c2!.id as string)
      expect(m).toMatchObject({ ok: true, moved: 1 })
      const [u] = await admin`select city_id from users where id = ${uid}`
      expect(u!.city_id).toBe(c2!.id)
      expect((await admin`select 1 from cities where id = ${c1!.id}`).length).toBe(0)
      await admin`update users set city_id = null where id = ${uid}`
      await admin`delete from cities where id = ${c2!.id}`
    }
    finally {
      await admin`delete from org_units where id in (${child!.id}, ${other!.id}, ${root!.id})`
    }
  })
})

describe('docs/31 рядок PersonCard: «Рейтинг» у зведенні «Навчання» для чужої людини', () => {
  it('personLearning рахує currentRating так само, як /me/study-history (studyHistory)', async () => {
    const { studyHistory } = await import('../../server/services/reportsExtra')
    const uid = await makePerson('Рейтинг Тест')
    const [enr] = await admin`insert into enrollments (tenant_id, user_id, subject_id, version_id, source, required_total, status, completed_at) values (${tenantId}, ${uid}, ${courseId}, ${versionId}, 'self', 1, 'done', now()) returning id`
    const [att] = await admin`insert into attempts (tenant_id, quiz_id, user_id, attempt_no, snapshot, params, status, passed, score, started_at, submitted_at) values (${tenantId}, ${quizId}, ${uid}, 1, '{}', '{}', 'passed', true, 90, now(), now()) returning id`
    try {
      const learning = await P.personLearning(ctx(), uid)
      const history = await studyHistory(ctx(), uid)
      expect(learning.currentRating).toBe(history.currentRating)
      expect(learning.currentRating).toBeGreaterThanOrEqual(2) // курс + тест
    }
    finally {
      await admin`delete from attempts where id = ${att!.id}`
      await admin`delete from enrollments where id = ${enr!.id}`
    }
  })
})
