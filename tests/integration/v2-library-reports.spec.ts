import postgres from 'postgres'
import { afterAll, beforeAll, describe, expect, it } from 'vitest'

/**
 * Хвосты библиотеки модулей (`docs/v2/31-module-library.md` §9, §11; ветка `library-tails`):
 * три отчёта — «Використання бібліотеки», «Застарілі посилання», «Пропозиції до бібліотеки», —
 * их выгрузка фоном (строки `reportRows`) и две служебные задачи — `library.orphan_scan`
 * (следы оборванных транзакций, только отчёт) и `library.version_retire` (версии, которые
 * никто не закрепляет дольше 90 дней, — в `retired`).
 */

process.env.ENCRYPTION_KEY ??= 'test-encryption-key'

const lib = await import('../../server/services/library')
const usages = await import('../../server/services/libraryUsages')
const reports = await import('../../server/services/libraryReports')
const { reportRows } = await import('../../server/services/reportExports')
const { setEmbeddingProvider, stubEmbeddingProvider } = await import('../../server/services/embeddings')
const { createCourse, addModule, addLesson } = await import('../../server/services/courses')

type Actor = Awaited<ReturnType<typeof lib.libraryActorOf>>

const admin = postgres(process.env.DATABASE_ADMIN_URL!, { max: 2, onnotice: () => {} })
const P = 'v2-lr '
const DAY = 86_400_000

let tenantId: string
let otherTenantId: string
let otherAdminId: string
let adminId: string
let authorId: string
let mentorId: string
let employeeId: string
let resourceForNodes: string

const actor = (actorId: string, over: Partial<Actor> = {}): Actor => ({
  tenantId, actorId, manage: false, publish: false, use: false, courseEdit: false, programManage: false, ...over,
})
const asAdmin = () => actor(adminId, { manage: true, publish: true, use: true, courseEdit: true, programManage: true })
const asAuthor = () => actor(authorId, { publish: true, use: true, courseEdit: true, programManage: true })
const asMentor = () => actor(mentorId, { use: true })

const text = (id: string, html: string) => ({ id, type: 'text' as const, html })

async function cleanup() {
  const tenants = [tenantId, otherTenantId]
  await admin`delete from library_module_usages where tenant_id in ${admin(tenants)}`
  await admin`delete from library_module_proposals where tenant_id in ${admin(tenants)}`
  await admin`update library_modules set current_version_id = null, draft_lesson_id = null where tenant_id in ${admin(tenants)}`
  await admin`update lessons set library_version_id = null where tenant_id in ${admin(tenants)} and library_version_id is not null`
  await admin`update trajectory_nodes set library_version_id = null where tenant_id in ${admin(tenants)} and library_version_id is not null`
  await admin`delete from resource_progress where tenant_id = ${tenantId} and resource_version_id in (
    select l.resource_version_id from library_module_versions v join lessons l on l.id = v.lesson_id where v.tenant_id = ${tenantId})`
  await admin`delete from library_module_versions where tenant_id in ${admin(tenants)}`
  await admin`delete from lessons where tenant_id in ${admin(tenants)} and library_module_id is not null`
  await admin`delete from library_modules where tenant_id in ${admin(tenants)}`
  await admin`delete from trajectories where tenant_id = ${tenantId} and title like ${`${P}%`}`
  await admin`delete from courses where tenant_id = ${tenantId} and title like ${`${P}%`}`
  await admin`delete from resources where tenant_id = ${tenantId} and (title like ${`${P}%`} or slug like 'library-v2-lr%')`
  await admin`delete from audit_log where tenant_id in ${admin(tenants)} and action in ('library.orphan_scan', 'library.version_retire')`
  await admin`delete from notifications where tenant_id = ${tenantId} and code like 'library_%'`
}

beforeAll(async () => {
  tenantId = (await admin`select id from tenants where slug = 'kappi'`)[0]!.id as string
  const [other] = await admin`insert into tenants (slug, name) values ('test-library-reports', 'Тест звітів бібліотеки')
    on conflict (slug) do update set name = excluded.name returning id`
  otherTenantId = other!.id as string
  const [oa] = await admin`insert into users (tenant_id, phone, full_name, status) values (${otherTenantId}, '+380679990001', 'Чужий адмін', 'active')
    on conflict do nothing returning id`
  otherAdminId = (oa?.id ?? (await admin`select id from users where tenant_id = ${otherTenantId} limit 1`)[0]!.id) as string
  const pick = async (phone: string) => (await admin`select id from users where tenant_id = ${tenantId} and phone = ${phone}`)[0]!.id as string
  adminId = await pick('+380661864742')
  authorId = await pick('+380670000001')
  mentorId = await pick('+380670000002')
  employeeId = await pick('+380670000003')
  resourceForNodes = (await admin`select id from resources where tenant_id = ${tenantId} and status = 'published' order by created_at limit 1`)[0]!.id as string
  setEmbeddingProvider(stubEmbeddingProvider(768))
  await cleanup()
})

afterAll(async () => {
  setEmbeddingProvider(null)
  await cleanup()
  await admin`delete from users where tenant_id = ${otherTenantId}`
  await admin`delete from tenants where id = ${otherTenantId}`
  await admin.end()
})

async function createModule(title: string, kind: 'article' | 'link' = 'article') {
  const created = await lib.createModule(asAuthor(), {
    title: `${P}${title}`, contentKind: kind, tags: [], coauthorIds: [], language: 'uk', body: [text('b1', `<p>${title}</p>`)],
    ...(kind === 'link' ? { externalUrl: 'https://example.com/lr' } : {}),
  })
  if (!created.ok) throw new Error(created.code)
  return created.module.id
}

async function publish(moduleId: string, changelog = 'Нова версія модуля') {
  await lib.updateModule(asAuthor(), moduleId, { body: [text('b1', `<p>${changelog} ${Math.random()}</p>`)] })
  const v = await lib.publishVersion(asAuthor(), moduleId, { changelog, isHotfix: false, notify: false })
  if (!v.ok) throw new Error(v.code)
  return v
}

async function trackWithTask(title: string) {
  const [t] = await admin`insert into trajectories (tenant_id, title, status, created_by) values (${tenantId}, ${`${P}${title}`}, 'draft', ${adminId}) returning id`
  const [n] = await admin`insert into trajectory_nodes (tenant_id, trajectory_id, kind, title, content_type, content_id)
    values (${tenantId}, ${t!.id}, 'task', 'Інструкція', 'resource', ${resourceForNodes}) returning id`
  return { trajectoryId: t!.id as string, nodeId: n!.id as string }
}

async function attach(moduleId: string, title: string) {
  const { trajectoryId, nodeId } = await trackWithTask(title)
  const r = await usages.attachUsage(asAuthor(), { libraryModuleId: moduleId, holderType: 'trajectory_node', holderId: nodeId, containerType: 'trajectory', containerId: trajectoryId, pinMode: 'fixed' })
  if (!r.ok) throw new Error(r.code)
  return r.usage
}

/** Снимок версии: материал и его версия — ими узел выдаёт модуль человеку. */
async function snapshotOf(moduleId: string, version: number) {
  const [r] = await admin`select rv.id as rv_id, rv.resource_id from library_module_versions v
    join lessons l on l.id = v.lesson_id join resource_versions rv on rv.id = l.resource_version_id
    where v.library_module_id = ${moduleId} and v.version = ${version}`
  return { resourceVersionId: r!.rv_id as string, resourceId: r!.resource_id as string }
}

async function opened(moduleId: string, version: number, userId: string, status: 'opened' | 'completed', daysAgo: number) {
  const s = await snapshotOf(moduleId, version)
  await admin`insert into resource_progress (tenant_id, user_id, resource_id, resource_version_id, status, first_opened_at, completed_at)
    values (${tenantId}, ${userId}, ${s.resourceId}, ${s.resourceVersionId}, ${status}, ${new Date(Date.now() - daysAgo * DAY)},
            ${status === 'completed' ? new Date() : null})`
}

// ── «Використання бібліотеки» ─────────────────────────────────────────────────────────

describe('«Використання бібліотеки» (§9)', () => {
  let used: string
  let unused: string

  beforeAll(async () => {
    used = await createModule('Хімія')
    await publish(used, 'Перша версія')
    await attach(used, 'Трек А')
    await publish(used, 'Друга версія')
    await attach(used, 'Трек Б')
    unused = await createModule('Посилання', 'link')
    await publish(unused, 'Перша версія')
    await opened(used, 1, employeeId, 'completed', 3)
    await opened(used, 2, mentorId, 'opened', 1)
    await opened(used, 2, authorId, 'completed', 45)
  })

  it('места, из них устаревшие, открытия за период и доля завершения', async () => {
    const rows = await reports.libraryUsageReport(asMentor(), {})
    const r = rows.find(x => x.moduleId === used)!
    expect(r).toMatchObject({ title: `${P}Хімія`, contentKind: 'article', status: 'published', version: 2, usages: 2, stale: 1, opens: 2, completionPct: 50 })
    expect(r.owner).toBeTruthy()
    expect(rows.find(x => x.moduleId === unused)).toMatchObject({ usages: 0, stale: 0, opens: 0, completionPct: null })
  })

  it('период сдвигает открытия: 45 дней назад попадает в широкий период', async () => {
    const from = new Date(Date.now() - 60 * DAY).toISOString().slice(0, 10)
    const r = (await reports.libraryUsageReport(asMentor(), { from })).find(x => x.moduleId === used)!
    expect(r).toMatchObject({ opens: 3, completionPct: 66.7 })
  })

  it('фильтры: тип, «тільки невикористовувані», владелец', async () => {
    expect((await reports.libraryUsageReport(asMentor(), { kind: 'link' })).map(r => r.moduleId)).toEqual([unused])
    const ids = (await reports.libraryUsageReport(asMentor(), { onlyUnused: true })).map(r => r.moduleId)
    expect(ids).toContain(unused)
    expect(ids).not.toContain(used)
    expect(await reports.libraryUsageReport(asMentor(), { ownerId: mentorId })).toEqual([])
  })

  it('чужой тенант строк не видит', async () => {
    expect(await reports.libraryUsageReport({ tenantId: otherTenantId, actorId: otherAdminId }, {})).toEqual([])
  })
})

// ── «Застарілі посилання» ─────────────────────────────────────────────────────────────

describe('«Застарілі посилання» (§9)', () => {
  let moduleId: string

  beforeAll(async () => {
    moduleId = await createModule('Застаріле')
    await publish(moduleId, 'Перша версія')
    await attach(moduleId, 'Трек відставання')
    await publish(moduleId, 'Друга версія')
    await publish(moduleId, 'Третя версія')
    await admin`update library_module_versions set published_at = now() - interval '10 days' where library_module_id = ${moduleId} and version = 2`
  })

  it('место на v1 при v3: отставание 2, дни с выхода v2, автор трека', async () => {
    const r = (await reports.libraryStaleReport(asMentor(), {})).find(x => x.moduleId === moduleId)!
    expect(r).toMatchObject({ containerType: 'trajectory', containerTitle: `${P}Трек відставання`, pinnedVersion: 1, latestVersion: 3, lag: 2, daysSinceNewer: 10 })
    expect(r.author).toBe('Адмін Каппі')
  })

  it('фильтры: отставание ≥ N, автор контейнера', async () => {
    expect((await reports.libraryStaleReport(asMentor(), { minLag: 3 })).some(x => x.moduleId === moduleId)).toBe(false)
    expect((await reports.libraryStaleReport(asMentor(), { minLag: 2 })).some(x => x.moduleId === moduleId)).toBe(true)
    expect((await reports.libraryStaleReport(asMentor(), { authorId: authorId })).some(x => x.moduleId === moduleId)).toBe(false)
    expect((await reports.libraryStaleReport(asMentor(), { authorId: adminId })).some(x => x.moduleId === moduleId)).toBe(true)
  })
})

// ── «Пропозиції до бібліотеки» ────────────────────────────────────────────────────────

describe('«Пропозиції до бібліотеки» (§9)', () => {
  beforeAll(async () => {
    const c = await createCourse({ tenantId, actorId: authorId }, { title: `${P}Курс пропозицій`, language: 'uk', strictOrder: true, isCatalogVisible: false, tags: [] })
    const mod = await addModule({ tenantId, actorId: authorId }, c.id, 'Розділ')
    const mk = async (title: string) => {
      const l = await addLesson({ tenantId, actorId: authorId }, { moduleId: mod!.id, title: `${P}${title}`, itemType: 'resource', resource: { body: [text('p1', `<p>${title}</p>`)] }, isRequired: true, videoThresholdPct: 90 })
      if (!l.ok) throw new Error(l.code)
      return l.lesson.id
    }
    const { createProposal, rejectProposal } = await import('../../server/services/libraryProposals')
    const a = await createProposal(asMentor(), { sourceLessonId: await mk('Урок наставника'), comment: 'Потрібно всім точкам' })
    if (!a.ok) throw new Error(a.code)
    const b = await createProposal(asAuthor(), { sourceLessonId: await mk('Урок методиста'), comment: 'Для онбордингу кухні' })
    if (!b.ok) throw new Error(b.code)
    await rejectProposal(asAdmin(), b.proposal.id, 'Такий модуль уже є в бібліотеці')
  })

  it('куратор видит все, с тем, кто решил, и комментарием решения', async () => {
    const rows = await reports.libraryProposalsReport(asAuthor(), {})
    expect(rows).toHaveLength(2)
    expect(rows.find(r => r.status === 'rejected')).toMatchObject({
      sourceLessonTitle: `${P}Урок методиста`, containerTitle: `${P}Курс пропозицій`, decidedBy: 'Адмін Каппі', decisionComment: 'Такий модуль уже є в бібліотеці',
    })
  })

  it('не-куратор видит только свои; фильтр статуса и периода', async () => {
    const mine = await reports.libraryProposalsReport(asMentor(), {})
    expect(mine.map(r => r.sourceLessonTitle)).toEqual([`${P}Урок наставника`])
    expect((await reports.libraryProposalsReport(asAuthor(), { status: 'pending' })).map(r => r.status)).toEqual(['pending'])
    const past = new Date(Date.now() - 400 * DAY).toISOString().slice(0, 10)
    expect(await reports.libraryProposalsReport(asAuthor(), { from: past, to: past })).toEqual([])
  })
})

// ── Выгрузка фоном: строки reportRows ─────────────────────────────────────────────────

describe('выгрузка отчётов библиотеки (report.export)', () => {
  it('строки §9 по имени `library-usage` с областью заказчика', async () => {
    const rows = await reportRows(tenantId, adminId, 'library-usage', {})
    expect(rows.length).toBeGreaterThan(0)
    expect(Object.keys(rows[0]!)).toEqual(['module', 'kind', 'status', 'category', 'owner', 'version', 'version_at', 'usages', 'stale', 'opens', 'completion_pct', 'updated_at'])
    expect((await reportRows(tenantId, adminId, 'library-stale', {})).length).toBeGreaterThan(0)
    expect((await reportRows(tenantId, adminId, 'library-proposals', { status: 'rejected' })).map(r => r.status)).toEqual(['rejected'])
  })

  it('без `library.view` (сотрудник) — пусто; неизвестный отчёт — пусто', async () => {
    expect(await reportRows(tenantId, employeeId, 'library-usage', {})).toEqual([])
    expect(await reportRows(tenantId, adminId, 'library-nope', {})).toEqual([])
  })
})

// ── library.orphan_scan ───────────────────────────────────────────────────────────────

describe('library.orphan_scan (§11)', () => {
  it('без находок — отчёт с нулём всё равно пишется', async () => {
    await admin`delete from audit_log where tenant_id = ${tenantId} and action = 'library.orphan_scan'`
    const r = await reports.libraryOrphanScan(tenantId)
    expect(r).toEqual({ found: 0, lessons: [], modules: [] })
    const view = await reports.latestLibraryScans({ tenantId, actorId: adminId })
    expect(view.orphanScan?.report).toEqual({ found: 0, lessons: [], modules: [] })
  })

  it('урок без модуля-держателя и версии, модуль без тела и опубликованный без версии — найдены, ничего не изменено', async () => {
    const a = await createModule('Обірваний')
    const [draft] = await admin`select draft_lesson_id from library_modules where id = ${a}`
    await admin`update library_modules set draft_lesson_id = null where id = ${a}`
    const b = await createModule('Без версії')
    await admin`update library_modules set status = 'published' where id = ${b}`

    const r = await reports.libraryOrphanScan(tenantId)
    expect(r.found).toBe(3)
    expect(r.lessons).toEqual([{ lessonId: draft!.draft_lesson_id, moduleId: a, title: expect.any(String) }])
    expect(r.modules).toEqual(expect.arrayContaining([
      { moduleId: a, title: `${P}Обірваний`, problem: 'no_body' },
      { moduleId: b, title: `${P}Без версії`, problem: 'no_version' },
    ]))
    const [still] = await admin`select count(*)::int as n from lessons where id = ${draft!.draft_lesson_id}`
    expect(still!.n).toBe(1)
    const [log] = await admin`select actor_id, after from audit_log where tenant_id = ${tenantId} and action = 'library.orphan_scan' order by created_at desc limit 1`
    expect(log!.actor_id).toBeNull()
    expect((log!.after as { found: number }).found).toBe(3)

    await admin`update library_modules set draft_lesson_id = ${draft!.draft_lesson_id} where id = ${a}`
    await admin`update library_modules set status = 'draft' where id = ${b}`
  })

  it('чужой тенант отчёта не видит', async () => {
    const view = await reports.latestLibraryScans({ tenantId: otherTenantId, actorId: otherAdminId })
    expect(view.orphanScan).toBeNull()
  })
})

// ── library.version_retire ────────────────────────────────────────────────────────────

describe('library.version_retire (§11)', () => {
  let moduleId: string
  let u1: string
  let u2: string

  const statusOf = async (version: number) => (await admin`select status from library_module_versions where library_module_id = ${moduleId} and version = ${version}`)[0]!.status as string
  const age = async () => {
    await admin`update library_module_versions set published_at = now() - interval '120 days' where library_module_id = ${moduleId}`
    await admin`update library_module_usages set updated_at = now() - interval '100 days', attached_at = now() - interval '110 days' where library_module_id = ${moduleId}`
  }

  beforeAll(async () => {
    moduleId = await createModule('Версії')
    await publish(moduleId, 'Перша версія')
    u1 = (await attach(moduleId, 'Трек на v1')).id
    await publish(moduleId, 'Друга версія')
    u2 = (await attach(moduleId, 'Трек на v2')).id
    await publish(moduleId, 'Третя версія')
  })

  it('место недавно ушло с v2 на v3 — v2 ещё в обороте', async () => {
    await admin`update library_module_versions set published_at = now() - interval '120 days' where library_module_id = ${moduleId}`
    const up = await usages.updateUsageVersion(asAuthor(), u2)
    expect(up.ok).toBe(true)
    const r = await reports.libraryVersionRetire(tenantId)
    expect(r.versions.some(v => v.moduleId === moduleId)).toBe(false)
    expect(await statusOf(2)).toBe('published')
  })

  it('через 90 дней без закрепления v2 уходит в retired; v1 (активное место) и текущая v3 — нет', async () => {
    await age()
    const r = await reports.libraryVersionRetire(tenantId)
    expect(r.versions.filter(v => v.moduleId === moduleId)).toEqual([{ versionId: expect.any(String), moduleId, moduleTitle: `${P}Версії`, version: 2 }])
    expect([await statusOf(1), await statusOf(2), await statusOf(3)]).toEqual(['published', 'retired', 'published'])
    const [log] = await admin`select after from audit_log where tenant_id = ${tenantId} and action = 'library.version_retire' order by created_at desc limit 1`
    expect((log!.after as { retired: number }).retired).toBeGreaterThanOrEqual(1)
    // тело выведенной версии читается по-прежнему (§4)
    const body = await lib.getVersion(asMentor(), moduleId, 2)
    expect(body).toBeTruthy()
    // повторный прогон ничего не дублирует
    expect((await reports.libraryVersionRetire(tenantId)).retired).toBe(0)
  })

  it('место на v1 отключено недавно — v1 ждёт; когда отключение старше 90 дней — retired', async () => {
    const d = await usages.detachUsage(asAuthor(), u1, { makeCopy: false })
    expect(d.ok).toBe(true)
    await reports.libraryVersionRetire(tenantId)
    expect(await statusOf(1)).toBe('published')
    await admin`update library_module_usages set detached_at = now() - interval '95 days' where id = ${u1}`
    await reports.libraryVersionRetire(tenantId)
    expect(await statusOf(1)).toBe('retired')
  })

  it('версия, на которую ссылается урок (в т.ч. опубликованной версии курса), не выводится', async () => {
    const m = await createModule('Урок курсу')
    await publish(m, 'Перша версія')
    await publish(m, 'Друга версія')
    const [v1] = await admin`select id from library_module_versions where library_module_id = ${m} and version = 1`
    const [anyLesson] = await admin`select l.id from lessons l where l.tenant_id = ${tenantId} and l.module_id is not null and l.item_type = 'resource' limit 1`
    const [snap] = await admin`select l.resource_version_id, l.item_id from library_module_versions v join lessons l on l.id = v.lesson_id where v.id = ${v1!.id}`
    const [was] = await admin`select item_id, resource_version_id, library_version_id from lessons where id = ${anyLesson!.id}`
    await admin`update lessons set library_version_id = ${v1!.id}, item_id = ${snap!.item_id}, resource_version_id = ${snap!.resource_version_id} where id = ${anyLesson!.id}`
    await admin`update library_module_versions set published_at = now() - interval '200 days' where library_module_id = ${m}`
    try {
      await reports.libraryVersionRetire(tenantId)
      const [s] = await admin`select status from library_module_versions where id = ${v1!.id}`
      expect(s!.status).toBe('published')
    }
    finally {
      await admin`update lessons set library_version_id = ${was!.library_version_id}, item_id = ${was!.item_id}, resource_version_id = ${was!.resource_version_id} where id = ${anyLesson!.id}`
    }
  })

  it('отчёт задачи виден в GET /library/scans', async () => {
    const view = await reports.latestLibraryScans({ tenantId, actorId: adminId })
    expect(view.versionRetire?.report.retired).toBeGreaterThanOrEqual(1)
  })
})
