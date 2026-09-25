import { readFileSync } from 'node:fs'
import postgres from 'postgres'
import { afterAll, beforeAll, describe, expect, it } from 'vitest'

/**
 * PR-26 пакета `docs/v2` (`45-plan.md`): библиотека в траекториях и поиск (`31-module-library.md`,
 * патч П-17).
 *
 * Условия выхода PR-26:
 * - **узел трека показывает закреплённую версию, а не последнюю** — на полотне (номер, название,
 *   иконка), в назначении, которое узел выдаёт человеку, и в том, что человек читает;
 * - ветвление графа (`TRAJECTORY_NODE_KINDS`, 9 значений) не сокращено.
 *
 * Критерии приёмки `31` §13, закреплённые за этим PR:
 * - **2** — место на v2, опубликована v4: диалог показывает changelog v3 и v4 и поблочный diff
 *   v2→v4, после подтверждения узел отдаёт тело v4;
 * - **6** — хотфикс и два места (5 активных прохождений и ноль): второе обновляется само, первое
 *   остаётся `stale`, его автор получает `library_hotfix_blocked`;
 * - **7** — `article` с 6 чек-листами из 10 блоков: иконка чек-листа, `content_kind` — `article`;
 * - **8** — «розведення» есть в теле последней версии, но не в названии: модуль находится.
 *
 * Плюс то, что PR-26 обязан не сломать: полотно не отвязывает модуль молча и откатывается
 * целиком при отказе вставки, дублирование траектории заводит места копии, отвязка делает
 * копию, перенос мест PR-25 в колонку (миграция 0088), ночная сверка, дайджест.
 */

process.env.ENCRYPTION_KEY ??= 'test-encryption-key'

const lib = await import('../../server/services/library')
const usages = await import('../../server/services/libraryUsages')
const tr = await import('../../server/services/trajectories')
const { setEmbeddingProvider, stubEmbeddingProvider } = await import('../../server/services/embeddings')
const { viewResource } = await import('../../server/services/resources')
const { renderTemplate, DEFAULT_TEMPLATES } = await import('../../server/services/notifications')
const { createCourse, addModule, addLesson, publishCourse, getCourseEditor } = await import('../../server/services/courses')
const { trajectoryGraphSchema } = await import('../../shared/schemas/trajectories')
const { TRAJECTORY_NODE_KINDS } = await import('../../shared/enums')

type Actor = ReturnType<typeof lib.libraryActorOf>
type GraphNode = Parameters<typeof tr.putGraph>[2]['nodes'][number]

const admin = postgres(process.env.DATABASE_ADMIN_URL!, { max: 2, onnotice: () => {} })
const P = 'v2-26 '
const PHONE = '+38063926' // диапазон PR-26, отдельный от остальных спек

let tenantId: string
let adminId: string
let authorId: string
let learnerId: string
let resourceForNodes: string
const people: string[] = []

const actor = (actorId: string, over: Partial<Actor> = {}): Actor => ({
  tenantId, actorId, manage: false, publish: false, use: false, courseEdit: false, programManage: false, ...over,
})
const asAdmin = () => actor(adminId, { manage: true, publish: true, use: true, courseEdit: true, programManage: true })
const asAuthor = () => actor(authorId, { publish: true, use: true, courseEdit: true, programManage: true })
const ctx = (actorId = adminId) => ({ tenantId, actorId })

const text = (id: string, html: string) => ({ id, type: 'text' as const, html })
const checklist = (id: string) => ({ id, type: 'checklist' as const, items: ['Пункт'], requireAll: false })

async function cleanup() {
  await admin`delete from library_module_usages where tenant_id = ${tenantId}`
  await admin`update trajectory_nodes set library_version_id = null where tenant_id = ${tenantId} and library_version_id is not null`
  await admin`update library_modules set current_version_id = null, draft_lesson_id = null where tenant_id = ${tenantId}`
  await admin`update lessons set library_version_id = null where tenant_id = ${tenantId} and library_version_id is not null`
  await admin`delete from library_module_versions where tenant_id = ${tenantId}`
  await admin`delete from lessons where tenant_id = ${tenantId} and library_module_id is not null`
  await admin`delete from library_module_proposals where tenant_id = ${tenantId}`
  await admin`delete from library_modules where tenant_id = ${tenantId}`
  const trajs = (await admin`select id from trajectories where tenant_id = ${tenantId} and title like ${`${P}%`}`).map(r => r.id as string)
  if (trajs.length) {
    await admin`delete from notifications where ref_type = 'trajectory_enrollment' and ref_id in (select id from trajectory_enrollments where trajectory_id in ${admin(trajs)})`
    await admin`delete from assignments where audience->>'trajectoryId' in ${admin(trajs)}`
    await admin`delete from trajectories where id in ${admin(trajs)}`
  }
  const courses = (await admin`select id from courses where tenant_id = ${tenantId} and title like ${`${P}%`}`).map(r => r.id as string)
  if (courses.length) {
    await admin`delete from enrollments where subject_id in ${admin(courses)}`
    await admin`delete from courses where id in ${admin(courses)}`
  }
  await admin`delete from resources where tenant_id = ${tenantId} and (title like ${`${P}%`} or slug like 'library-v2-26%')`
  await admin`delete from notifications where tenant_id = ${tenantId} and code like 'library_%'`
}

beforeAll(async () => {
  tenantId = (await admin`select id from tenants where slug = 'kappi'`)[0]!.id as string
  const pick = async (phone: string) => (await admin`select id from users where tenant_id = ${tenantId} and phone = ${phone}`)[0]!.id as string
  adminId = await pick('+380661864742')
  authorId = await pick('+380670000001')
  learnerId = await pick('+380670000003')
  resourceForNodes = (await admin`select id from resources where tenant_id = ${tenantId} and status = 'published' order by created_at limit 1`)[0]!.id as string
  setEmbeddingProvider(stubEmbeddingProvider(768))
  await cleanup()
  // Пять человек для «5 активных прохождений» критерия 6
  for (let i = 0; i < 5; i++) {
    const [u] = await admin`insert into users (tenant_id, phone, full_name, status, hired_at)
      values (${tenantId}, ${`${PHONE}${String(i).padStart(3, '0')}`}, ${`${P}Учень ${i}`}, 'active', current_date)
      on conflict do nothing returning id`
    people.push((u?.id ?? (await pick(`${PHONE}${String(i).padStart(3, '0')}`))) as string)
  }
})

afterAll(async () => {
  setEmbeddingProvider(null)
  await cleanup()
  await admin`delete from notifications where user_id in ${admin(people)}`
  await admin`delete from users where id in ${admin(people)}`
  await admin.end()
})

/** Опубликованный модуль: v1 и, если даны, следующие версии — каждая своим телом. */
async function moduleWithVersions(title: string, bodies: { blocks: unknown[], changelog: string, isHotfix?: boolean }[], over: { contentKind?: 'article' | 'file' | 'video' | 'link', summary?: string, tags?: string[] } = {}) {
  const created = await lib.createModule(asAuthor(), {
    title: `${P}${title}`, contentKind: over.contentKind ?? 'article', tags: over.tags ?? [], coauthorIds: [], language: 'uk',
    summary: over.summary ?? null, body: bodies[0]!.blocks as never,
  })
  if (!created.ok) throw new Error(created.code)
  const versions: string[] = []
  for (const [i, b] of bodies.entries()) {
    if (i > 0) await lib.updateModule(asAuthor(), created.module.id, { body: b.blocks as never })
    const v = await lib.publishVersion(asAuthor(), created.module.id, { changelog: b.changelog, isHotfix: b.isHotfix ?? false, notify: false })
    if (!v.ok) throw new Error(v.code)
    versions.push(v.version.id)
  }
  return { id: created.module.id, versions }
}

async function publishNext(moduleId: string, blocks: unknown[], changelog: string, isHotfix = false) {
  await lib.updateModule(asAuthor(), moduleId, { body: blocks as never })
  const v = await lib.publishVersion(asAuthor(), moduleId, { changelog, isHotfix, notify: false })
  if (!v.ok) throw new Error(v.code)
  return v.version
}

/** Траектория Start → узел из палитры (модуль библиотеки) → Finish, сохранённая одним PUT полотна. */
async function libraryTrack(title: string, moduleId: string, opts: { publish?: boolean } = {}) {
  const t = await tr.createTrajectory(ctx(), { title: `${P}${title}`, tags: [] })
  const full = (await tr.getTrajectory(ctx(), t.id))!
  const start = full.nodes.find(n => n.kind === 'start')!
  const finish = full.nodes.find(n => n.kind === 'finish')!
  const g = await tr.putGraph(ctx(), t.id, {
    nodes: [
      { id: start.id, kind: 'start', x: 0, y: 0 },
      { id: finish.id, kind: 'finish', x: 400, y: 0 },
      { tmpId: 'tmp:lib', kind: 'task', libraryModuleId: moduleId, params: {}, x: 200, y: 0 } as GraphNode,
    ],
    edges: [{ fromNodeId: start.id, toNodeId: 'tmp:lib', sort: 0 }, { fromNodeId: 'tmp:lib', toNodeId: finish.id, sort: 0 }],
  }, { libraryUse: true })
  if (!g.ok) throw new Error(`graph: ${JSON.stringify(g)}`)
  const nodeId = g.ids['tmp:lib']!
  if (opts.publish) {
    const p = await tr.publishTrajectory(ctx(), t.id)
    if (!p.ok) throw new Error(`publish: ${JSON.stringify(p.problems)}`)
  }
  const node = g.nodes.find(n => n.id === nodeId)!
  return { trajectoryId: t.id, nodeId, startId: start.id, finishId: finish.id, usageId: node.library!.usageId!, graph: g }
}

async function nodeOf(trajectoryId: string, nodeId: string) {
  return (await tr.getTrajectory(ctx(), trajectoryId))!.nodes.find(n => n.id === nodeId)!
}

/** Назначение, которое узел выдал человеку, и снимок, за которым оно закреплено. */
async function nodeAssignment(trajectoryId: string, nodeId: string, userId: string) {
  const [row] = await admin`select a.id, a.subject_type, a.subject_id, a.subject_version_id from trajectory_node_states s
    join trajectory_enrollments e on e.id = s.enrollment_id join assignments a on a.id = s.assignment_id
    where e.trajectory_id = ${trajectoryId} and e.user_id = ${userId} and s.node_id = ${nodeId}`
  return row as { id: string, subject_type: string, subject_id: string, subject_version_id: string } | undefined
}

// ── Условие выхода: ветвление графа не сокращено ─────────────────────────────────────────

describe('условие выхода: TRAJECTORY_NODE_KINDS — девять видов узла (П-17 п. 2)', () => {
  const NINE = ['start', 'finish', 'task', 'and', 'or', 'delay', 'stop_delay', 'branch', 'mentor']

  it('перечень в коде и CHECK в БД — ровно девять одних и тех же значений', async () => {
    expect([...TRAJECTORY_NODE_KINDS].sort()).toEqual([...NINE].sort())
    const [c] = await admin`select pg_get_constraintdef(oid) as def from pg_constraint where conname = 'trajectory_nodes_kind_trajectory_node_kind'`
    for (const k of NINE) expect(c!.def as string).toContain(`'${k}'`)
    expect((c!.def as string).match(/'[a-z_]+'::text/g)).toHaveLength(9)
  })

  it('контракт полотна принимает каждый из девяти видов, узел-ссылка — только задание', () => {
    const uuid = '00000000-0000-4000-8000-000000000001'
    const nodes = NINE.map((kind, i) => ({
      tmpId: `tmp:${i}`, kind, x: 0, y: 0, title: 'Підпис', days: 1, contentType: 'resource', contentId: uuid, params: {},
    }))
    const parsed = trajectoryGraphSchema.safeParse({ nodes, edges: [] })
    expect(parsed.success).toBe(true)
    // Задание без контента и без модуля — понятная ошибка, а не «Expected string»
    const bad = trajectoryGraphSchema.safeParse({ nodes: [{ tmpId: 'tmp:x', kind: 'task', x: 0, y: 0, params: {} }], edges: [] })
    expect(bad.success).toBe(false)
    if (!bad.success) expect(bad.error.issues[0]!.message).toBe('Оберіть контент для блоку «Завдання» або модуль бібліотеки')
  })

  it('ссылка на версию бывает только у узла-задания с материалом (trajectory_nodes_library_ref_ck)', async () => {
    const m = await moduleWithVersions('Не в логіку графа', [{ blocks: [text('b1', '<p>x</p>')], changelog: 'Перша версія' }])
    const { trajectoryId } = await libraryTrack('Трек констрейнту', m.id)
    await expect(admin`insert into trajectory_nodes (tenant_id, trajectory_id, kind, title, library_version_id) values (${tenantId}, ${trajectoryId}, 'and', 'І', ${m.versions[0]!})`)
      .rejects.toMatchObject({ code: '23514', constraint_name: 'trajectory_nodes_library_ref_ck' })
  })
})

// ── Условие выхода: узел показывает закреплённую версию ──────────────────────────────────

describe('условие выхода: узел трека показывает закреплённую версию, а не последнюю', () => {
  it('полотно: «Бібліотека · v1», название и иконка — из v1; v2 только номером для баннера', async () => {
    const m = await moduleWithVersions('Мийка посуду', [{ blocks: [text('b1', '<p>Версія 1</p>')], changelog: 'Перша версія' }])
    const t = await libraryTrack('Трек посуду', m.id)
    const before = await nodeOf(t.trajectoryId, t.nodeId)
    expect(before).toMatchObject({ contentType: 'resource', contentTitle: `${P}Мийка посуду` })
    expect(before.library).toMatchObject({ moduleId: m.id, version: 1, latestVersion: 1, isStale: false, pinMode: 'hotfix_auto', typeIcon: 'text' })

    // v2 меняет и название, и тело на чек-лист — узел не меняется ни в чём, кроме баннера
    await lib.updateModule(asAuthor(), m.id, { title: `${P}Мийка посуду (нова)` })
    await publishNext(m.id, [checklist('c1'), checklist('c2')], 'Друга версія: чек-лист')
    const after = await nodeOf(t.trajectoryId, t.nodeId)
    expect(after.contentTitle).toBe(`${P}Мийка посуду`)
    expect(after.library).toMatchObject({ version: 1, latestVersion: 2, isStale: true, typeIcon: 'text', versionTitle: `${P}Мийка посуду` })
    const [row] = await admin`select library_version_id from trajectory_nodes where id = ${t.nodeId}`
    expect(row!.library_version_id).toBe(m.versions[0])
  })

  it('человек получает назначение, закреплённое за снимком v1, и читает тело v1 после выхода v2', async () => {
    const m = await moduleWithVersions('Техніка ножа', [{ blocks: [text('b1', '<p>Ніж v1</p>')], changelog: 'Перша версія' }])
    const t = await libraryTrack('Трек ножа', m.id, { publish: true })
    await publishNext(m.id, [text('b1', '<p>Ніж v2</p>')], 'Друга версія')
    const r = await tr.assignTrajectory(ctx(), t.trajectoryId, [learnerId])
    expect(r.ok && r.added).toBe(1)
    const a = await nodeAssignment(t.trajectoryId, t.nodeId, learnerId)
    expect(a).toBeDefined()
    const [v1] = await admin`select l.resource_version_id from library_module_versions v join lessons l on l.id = v.lesson_id where v.id = ${m.versions[0]!}`
    expect(a!.subject_type).toBe('resource')
    expect(a!.subject_version_id).toBe(v1!.resource_version_id)
    const seen = await viewResource({ tenantId, actorId: learnerId }, a!.subject_id, { assignmentId: a!.id })
    expect(seen).toMatchObject({ pinned: true, version: 1 })
    expect(seen!.body).toEqual([text('b1', '<p>Ніж v1</p>')])
    // Тело модуля по-прежнему не читается без назначения и чужим назначением (libraryBody.ts)
    expect(await viewResource({ tenantId, actorId: learnerId }, a!.subject_id)).toBeNull()
    expect(await viewResource({ tenantId, actorId: people[0]! }, a!.subject_id, { assignmentId: a!.id })).toBeNull()
  })

  it('лента человека называет шаг названием закреплённой версии', async () => {
    const m = await moduleWithVersions('Стрічка', [{ blocks: [text('b1', '<p>x</p>')], changelog: 'Перша версія' }])
    const t = await libraryTrack('Трек стрічки', m.id, { publish: true })
    await lib.updateModule(asAuthor(), m.id, { title: `${P}Стрічка (перейменовано)` })
    await publishNext(m.id, [text('b1', '<p>y</p>')], 'Друга версія')
    await tr.assignTrajectory(ctx(), t.trajectoryId, [people[4]!])
    const [e] = await admin`select id from trajectory_enrollments where trajectory_id = ${t.trajectoryId} and user_id = ${people[4]!}`
    const ladder = await tr.myTrajectory(ctx(people[4]!), e!.id as string)
    expect(ladder!.steps.find(s => s.nodeId === t.nodeId)!.contentTitle).toBe(`${P}Стрічка`)
  })
})

// ── Критерий 2: «Оновити до останньої версії» ────────────────────────────────────────────

describe('критерий 2: место на v2, вышла v4 — диалог и обновление', () => {
  let moduleId: string
  let t: Awaited<ReturnType<typeof libraryTrack>>
  let earlyAssignment: Awaited<ReturnType<typeof nodeAssignment>>

  beforeAll(async () => {
    const m = await moduleWithVersions('Використання хімії', [
      { blocks: [text('b1', '<p>Розводимо 1:20</p>')], changelog: 'Перша версія' },
      { blocks: [text('b1', '<p>Розводимо 1:10</p>'), text('b2', '<p>Рукавички</p>')], changelog: 'Друга: рукавички' },
    ])
    moduleId = m.id
    t = await libraryTrack('Трек хімії', moduleId, { publish: true })
    // Человек, получивший задание на v2, — до выхода v3 и v4
    await tr.assignTrajectory(ctx(), t.trajectoryId, [learnerId])
    earlyAssignment = await nodeAssignment(t.trajectoryId, t.nodeId, learnerId)
    await publishNext(moduleId, [text('b1', '<p>Розводимо 1:10 у теплій воді</p>'), text('b2', '<p>Рукавички</p>')], 'Третя: тепла вода')
    await publishNext(moduleId, [text('b1', '<p>Розводимо 1:10 у теплій воді</p>'), text('b3', '<p>Провітрювання</p>')], 'Четверта: провітрювання')
  })

  it('диалог: changelog v3 и v4, поблочный diff v2→v4, «N людей уже почали»', async () => {
    const node = await nodeOf(t.trajectoryId, t.nodeId)
    expect(node.library).toMatchObject({ version: 2, latestVersion: 4, isStale: true })
    const r = await usages.updatePreview(asAuthor(), t.usageId)
    expect(r.ok).toBe(true)
    if (!r.ok) return
    const { compare, alreadyStarted } = r.preview
    expect(compare.from.version).toBe(2)
    expect(compare.to.version).toBe(4)
    expect(compare.changelogs.map(c => [c.version, c.changelog])).toEqual([[3, 'Третя: тепла вода'], [4, 'Четверта: провітрювання']])
    // v2→v4 напрямую: b1 изменён, b2 удалён, b3 добавлен
    expect(compare.diff).toEqual({ added: ['b3'], removed: ['b2'], changed: ['b1'] })
    expect(compare.before.map(b => b.id)).toEqual(['b1', 'b2'])
    expect(compare.after.map(b => b.id)).toEqual(['b1', 'b3'])
    // Задание на v2 уже у одного человека — он и останется на v2
    expect(alreadyStarted).toBe(1)
  })

  it('без права на трек не обновить; назад и на ту же версию — нельзя', async () => {
    const mentor = actor(adminId, { use: true })
    expect(await usages.updateUsageVersion(mentor, t.usageId)).toEqual({ ok: false, code: 'container_forbidden' })
    expect(await usages.updateUsageVersion(asAuthor(), t.usageId, { toVersion: 1 })).toEqual({ ok: false, code: 'version_downgrade' })
    expect(await usages.updateUsageVersion(asAuthor(), t.usageId, { toVersion: 2 })).toEqual({ ok: false, code: 'already_latest' })
    expect(await usages.updateUsageVersion(asAuthor(), t.usageId, { toVersion: 9 })).toEqual({ ok: false, code: 'version_not_found' })
  })

  it('после подтверждения узел отдаёт тело v4, а начавший на v2 остаётся на v2', async () => {
    const r = await usages.updateUsageVersion(asAuthor(), t.usageId)
    expect(r.ok).toBe(true)
    if (!r.ok) return
    expect(r).toMatchObject({ updatedFrom: 2, updatedTo: 4 })
    expect(r.usage).toMatchObject({ version: 4, latestVersion: 4, isStale: false })
    const node = await nodeOf(t.trajectoryId, t.nodeId)
    expect(node.library).toMatchObject({ version: 4, isStale: false })
    const pinned = await lib.getVersion(asAuthor(), moduleId, node.library!.version)
    expect(pinned!.body).toEqual([text('b1', '<p>Розводимо 1:10 у теплій воді</p>'), text('b3', '<p>Провітрювання</p>')])

    // Новый человек получает v4 …
    await tr.assignTrajectory(ctx(), t.trajectoryId, [people[3]!])
    const fresh = await nodeAssignment(t.trajectoryId, t.nodeId, people[3]!)
    const seenFresh = await viewResource({ tenantId, actorId: people[3]! }, fresh!.subject_id, { assignmentId: fresh!.id })
    expect(seenFresh!.body.map(b => b.id)).toEqual(['b1', 'b3'])
    // … а тот, кто получил задание на v2, доучивается на v2 (Р-31.2)
    const seenEarly = await viewResource({ tenantId, actorId: learnerId }, earlyAssignment!.subject_id, { assignmentId: earlyAssignment!.id })
    expect(seenEarly!.body).toEqual([text('b1', '<p>Розводимо 1:10</p>'), text('b2', '<p>Рукавички</p>')])

    const [audit] = await admin`select after from audit_log where tenant_id = ${tenantId} and action = 'library_usage.update_version' and entity_id = ${moduleId} order by created_at desc limit 1`
    expect(audit!.after).toMatchObject({ usageId: t.usageId, version: 4 })
  })

  it('сравнение версий: «Порівняти з v3» и та же версия — отказ', async () => {
    const c = await lib.compareVersions(asAuthor(), moduleId, 3, 4)
    expect(c.ok && c.compare.diff).toEqual({ added: ['b3'], removed: ['b2'], changed: [] })
    expect(await lib.compareVersions(asAuthor(), moduleId, 3, 3)).toEqual({ ok: false, code: 'same_version' })
    expect(await lib.compareVersions(asAuthor(), moduleId, 3, 7)).toEqual({ ok: false, code: 'not_found' })
  })
})

describe('«Оновити все до v4» — только library.manage', () => {
  it('обновляет устаревшие места; место уже на последней не трогает', async () => {
    const m = await moduleWithVersions('Масове оновлення', [{ blocks: [text('b1', '<p>1</p>')], changelog: 'Перша версія' }])
    const a = await libraryTrack('Масовий трек A', m.id)
    const b = await libraryTrack('Масовий трек B', m.id)
    await publishNext(m.id, [text('b1', '<p>2</p>')], 'Друга версія')
    const c = await libraryTrack('Масовий трек C', m.id) // уже на v2
    expect(await usages.updateAllUsages(asAuthor(), m.id)).toEqual({ ok: false, code: 'forbidden' })
    const r = await usages.updateAllUsages(asAdmin(), m.id)
    expect(r).toEqual({ ok: true, updated: 2, skipped: [], toVersion: 2 })
    for (const t of [a, b, c]) expect((await nodeOf(t.trajectoryId, t.nodeId)).library).toMatchObject({ version: 2, isStale: false })
  })
})

// ── Критерий 6: «Критичне виправлення» ───────────────────────────────────────────────────

describe('критерий 6: хотфикс и два места — с пятью прохождениями и без', () => {
  let moduleId: string
  let busy: Awaited<ReturnType<typeof libraryTrack>>
  let idle: Awaited<ReturnType<typeof libraryTrack>>
  let fixedUsageId: string
  let hotfix: Awaited<ReturnType<typeof publishNext>>

  beforeAll(async () => {
    const m = await moduleWithVersions('Санітарна обробка', [{ blocks: [text('b1', '<p>Хлор 1:50</p>')], changelog: 'Перша версія' }])
    moduleId = m.id
    busy = await libraryTrack('Трек з людьми', moduleId, { publish: true })
    const r = await tr.assignTrajectory(ctx(), busy.trajectoryId, people)
    expect(r.ok && r.added).toBe(5)
    idle = await libraryTrack('Трек без людей', moduleId, { publish: true })
    // Третье место — с режимом fixed: хотфикс сам туда не доезжает
    const [plain] = await admin`insert into trajectories (tenant_id, title, status, created_by) values (${tenantId}, ${`${P}Трек fixed`}, 'draft', ${adminId}) returning id`
    const [node] = await admin`insert into trajectory_nodes (tenant_id, trajectory_id, kind, title, content_type, content_id) values (${tenantId}, ${plain!.id}, 'task', 'Інструкція', 'resource', ${resourceForNodes}) returning id`
    const fixed = await usages.attachUsage(asAuthor(), { libraryModuleId: moduleId, holderType: 'trajectory_node', holderId: node!.id as string, containerType: 'trajectory', containerId: plain!.id as string, pinMode: 'fixed' })
    if (!fixed.ok) throw new Error(fixed.code)
    fixedUsageId = fixed.usage.id
    hotfix = await publishNext(moduleId, [text('b1', '<p>Хлор 1:100 — 1:50 небезпечно</p>')], 'Помилка в концентрації', true)
  })

  it('до разнесения все три места устаревшие', async () => {
    const list = await usages.listUsages(asAuthor(), moduleId)
    expect(list!.active).toHaveLength(3)
    expect(list!.active.every(u => u.isStale && u.version === 1)).toBe(true)
  })

  it('второе обновляется само, первое остаётся stale, fixed не трогается; авторам — по уведомлению', async () => {
    const s = await usages.propagateHotfix(tenantId, moduleId, hotfix.id)
    expect(s).toMatchObject({ applied: 1, blocked: 1, skipped: 1 })

    expect((await nodeOf(idle.trajectoryId, idle.nodeId)).library).toMatchObject({ version: 2, isStale: false })
    expect((await nodeOf(busy.trajectoryId, busy.nodeId)).library).toMatchObject({ version: 1, isStale: true })
    const list = await usages.listUsages(asAuthor(), moduleId)
    expect(list!.active.find(u => u.id === fixedUsageId)).toMatchObject({ version: 1, isStale: true, pinMode: 'fixed' })

    const sent = await admin`select code, payload, channel from notifications where tenant_id = ${tenantId} and user_id = ${adminId} and code like 'library_hotfix_%' and ref_id = ${moduleId}`
    const blocked = sent.find(n => n.code === 'library_hotfix_blocked')
    const applied = sent.find(n => n.code === 'library_hotfix_applied')
    expect(blocked!.payload).toMatchObject({ container: `${P}Трек з людьми`, inProgress: true })
    expect(applied!.payload).toMatchObject({ container: `${P}Трек без людей` })
    expect(renderTemplate(DEFAULT_TEMPLATES.library_hotfix_blocked!, blocked!.payload as Record<string, unknown>))
      .toBe(`Критичне виправлення «${P}Санітарна обробка» не застосовано у «${P}Трек з людьми»: люди вже проходять. Оновіть вручну`)
  })

  it('повторный прогон ничего не дублирует', async () => {
    const again = await usages.propagateHotfix(tenantId, moduleId, hotfix.id)
    expect(again).toMatchObject({ applied: 0, blocked: 1, notified: 0 })
    const [n] = await admin`select count(*)::int as n from notifications where tenant_id = ${tenantId} and code like 'library_hotfix_%' and ref_id = ${moduleId}`
    expect(n!.n).toBe(2)
  })

  it('обычная версия хотфиксом не разносится', async () => {
    const plainVersion = await publishNext(moduleId, [text('b1', '<p>Ще уточнення</p>')], 'Звичайна версія')
    expect(await usages.propagateHotfix(tenantId, moduleId, plainVersion.id)).toEqual({ applied: 0, blocked: 0, skipped: 0, notified: 0 })
  })
})

// ── Урок курса: версию меняют только в черновике курса ──────────────────────────────────

describe('урок курса как место: обновление и хотфикс — только в черновой версии курса (§7.3, §7.4)', () => {
  let moduleId: string
  let courseId: string
  let usageId: string
  let hotfixId: string

  beforeAll(async () => {
    moduleId = (await moduleWithVersions('Модуль у курсі', [{ blocks: [text('b1', '<p>Курс v1</p>')], changelog: 'Перша версія' }])).id
    const c = await createCourse({ tenantId, actorId: adminId }, { title: `${P}Курс із модулем`, language: 'uk', strictOrder: true, isCatalogVisible: false, tags: [] })
    courseId = c.id
    const mod = await addModule({ tenantId, actorId: adminId }, c.id, 'Розділ')
    const l = await addLesson({ tenantId, actorId: adminId }, { moduleId: mod!.id, title: `${P}Урок-місце`, itemType: 'resource', resource: { body: [text('own', '<p>Свій</p>')] }, isRequired: true, videoThresholdPct: 90 })
    if (!l.ok) throw new Error(l.code)
    const r = await usages.attachUsage(asAuthor(), { libraryModuleId: moduleId, holderType: 'course_lesson', holderId: l.lesson.id, containerType: 'course', containerId: courseId, pinMode: 'hotfix_auto' })
    if (!r.ok) throw new Error(r.code)
    usageId = r.usage.id
    expect((await publishCourse({ tenantId, actorId: adminId }, courseId, 'Курс з модулем')).ok).toBe(true)
    hotfixId = (await publishNext(moduleId, [text('b1', '<p>Курс v2</p>')], 'Критична правка', true)).id
  })

  it('урок опубликованной версии курса не обновляется ни одиночно, ни массово', async () => {
    expect(await usages.updateUsageVersion(asAuthor(), usageId)).toEqual({ ok: false, code: 'container_published' })
    const all = await usages.updateAllUsages(asAdmin(), moduleId)
    expect(all).toMatchObject({ ok: true, updated: 0, skipped: [{ usageId, reason: 'container_published' }] })
  })

  it('хотфикс без людей в процессе всё равно не трогает опубликованную версию курса — автору причина', async () => {
    const s = await usages.propagateHotfix(tenantId, moduleId, hotfixId)
    expect(s).toMatchObject({ applied: 0, blocked: 1 })
    const [n] = await admin`select payload from notifications where tenant_id = ${tenantId} and code = 'library_hotfix_blocked' and ref_id = ${moduleId}`
    expect(n!.payload).toMatchObject({ published: true, inProgress: false })
    expect(renderTemplate(DEFAULT_TEMPLATES.library_hotfix_blocked!, n!.payload as Record<string, unknown>)).toContain('опубліковану версію курсу не змінюють')
  })

  it('редактор курса создаёт черновик — место переходит за ним и обновляется; опубликованный урок остаётся на v1', async () => {
    const [published] = await admin`select holder_id from library_module_usages where id = ${usageId}`
    const editor = await getCourseEditor({ tenantId, actorId: adminId }, courseId)
    const draftLesson = editor!.modules[0]!.lessons[0]!
    const r = await usages.updateUsageVersion(asAuthor(), usageId)
    expect(r).toMatchObject({ ok: true, updatedFrom: 1, updatedTo: 2 })
    const [draft] = await admin`select rv.body from lessons l join resource_versions rv on rv.id = l.resource_version_id where l.id = ${draftLesson.id}`
    expect(draft!.body).toEqual([text('b1', '<p>Курс v2</p>')])
    const [old] = await admin`select rv.body from lessons l join resource_versions rv on rv.id = l.resource_version_id where l.id = ${published!.holder_id}`
    expect(old!.body).toEqual([text('b1', '<p>Курс v1</p>')])
  })
})

// ── Критерий 7: иконка колонки «Тип» ─────────────────────────────────────────────────────

describe('критерий 7: иконка «Тип» по доминирующему блоку, content_kind не меняется', () => {
  it('article с 6 чек-листами из 10 блоков — чек-лист', async () => {
    const blocks = [...[1, 2, 3, 4, 5, 6].map(i => checklist(`c${i}`)), ...[1, 2, 3, 4].map(i => text(`t${i}`, '<p>Текст</p>'))]
    const m = await moduleWithVersions('Чек-лист відкриття', [{ blocks, changelog: 'Перша версія' }])
    const list = await lib.listModules(asAuthor(), { status: 'all', q: `${P}Чек-лист відкриття`, limit: 25 })
    const card = list.items.find(i => i.id === m.id)!
    expect(card).toMatchObject({ contentKind: 'article', typeIcon: 'checklist' })
    expect((await lib.getModule(asAuthor(), m.id))!.contentKind).toBe('article')
  })

  it('таблица в тексте — таблица; меньше половины чек-листов и без таблицы — «T»', async () => {
    const table = await moduleWithVersions('Таблиця дозувань', [{ blocks: [text('t1', '<table><tr><td>1:10</td></tr></table>'), checklist('c1'), text('t2', '<p>x</p>')], changelog: 'Перша версія' }])
    const plain = await moduleWithVersions('Просто текст', [{ blocks: [checklist('c1'), text('t1', '<p>x</p>'), text('t2', '<p>y</p>')], changelog: 'Перша версія' }])
    const list = await lib.listModules(asAuthor(), { status: 'published', q: P.trim(), limit: 50 })
    expect(list.items.find(i => i.id === table.id)!.typeIcon).toBe('table')
    expect(list.items.find(i => i.id === plain.id)!.typeIcon).toBe('text')
  })
})

// ── Критерий 8: поиск по телу последней версии ───────────────────────────────────────────

describe('критерий 8: «розведення» есть только в теле последней версии', () => {
  let chemistry: string
  let draftOnly: string

  beforeAll(async () => {
    chemistry = (await moduleWithVersions('Використання хімії засобів', [
      { blocks: [text('b1', '<p>Засоби для підлоги</p>')], changelog: 'Перша версія' },
      { blocks: [text('b1', '<p>Правила розведення засобів для підлоги: 1:10 у теплій воді</p>')], changelog: 'Друга версія' },
    ], { summary: 'Як працювати з миючими засобами', tags: ['прибирання'] })).id
    // Слово есть только в черновике — искать его нельзя: вставляется версия, а не черновик
    const d = await lib.createModule(asAuthor(), { title: `${P}Чернетка інструкції`, contentKind: 'article', tags: [], coauthorIds: [], language: 'uk', body: [text('b1', '<p>Нічого</p>')] })
    if (!d.ok) throw new Error(d.code)
    await lib.publishVersion(asAuthor(), d.module.id, { changelog: 'Перша версія', isHotfix: false, notify: false })
    await lib.updateModule(asAuthor(), d.module.id, { body: [text('b1', '<p>Тут розведення тільки в чернетці</p>')] })
    draftOnly = d.module.id
    await lib.refreshLibraryEmbeddings(tenantId, [chemistry, draftOnly])
  })

  it('одним словом: модуль находится полнотекстом по телу версии, черновик — нет', async () => {
    const r = await lib.listModules(asAuthor(), { status: 'published', q: 'розведення', limit: 25 })
    expect(r.items.map(i => i.id)).toContain(chemistry)
    expect(r.items.map(i => i.id)).not.toContain(draftOnly)
    expect(r.nextCursor).toBeNull()
  })

  it('недописанное слово в палитре находит модуль (префиксный запрос)', async () => {
    const r = await lib.listModules(asAuthor(), { status: 'published', q: 'розвед', limit: 25 })
    expect(r.items.map(i => i.id)).toContain(chemistry)
  })

  it('запрос длиннее трёх слов — гибрид с вектором и RRF; модуль первым', async () => {
    const r = await lib.listModules(asAuthor(), { status: 'published', q: 'як правильно розводити засоби для миття підлоги', limit: 25 })
    expect(r.items[0]?.id).toBe(chemistry)
  })

  it('длинный запрос не о чём — «нічого не знайшли», а не весь список', async () => {
    const r = await lib.listModules(asAuthor(), { status: 'published', q: 'зовсім інша тема про погоду завтра вранці', limit: 25 })
    expect(r.items.map(i => i.id)).not.toContain(chemistry)
  })
})

// ── Палитра, полотно, дублирование, отвязка ───────────────────────────────────────────────

describe('палитра «Бібліотека модулів ▸» (§5.4)', () => {
  it('последние использованные: сначала свои, без архивных', async () => {
    const a = await moduleWithVersions('Палітра A', [{ blocks: [text('b1', '<p>a</p>')], changelog: 'Перша версія' }])
    const b = await moduleWithVersions('Палітра B', [{ blocks: [text('b1', '<p>b</p>')], changelog: 'Перша версія' }])
    await libraryTrack('Трек палітри A', a.id)
    await libraryTrack('Трек палітри B', b.id)
    const mine = await lib.recentModules(actor(adminId, { use: true }))
    expect(mine.slice(0, 2).map(m => m.id)).toEqual([b.id, a.id])
    expect(mine[0]).toMatchObject({ typeIcon: 'text', currentVersion: { version: 1 } })
    await lib.archiveModule(asAuthor(), b.id, 'Більше не потрібен')
    expect((await lib.recentModules(actor(adminId, { use: true }))).map(m => m.id)).not.toContain(b.id)
  })
})

describe('полотно и узел-ссылка', () => {
  it('сохранение без libraryModuleId и с чужим контентом ссылку не снимает', async () => {
    const m = await moduleWithVersions('Не відвʼязується', [{ blocks: [text('b1', '<p>x</p>')], changelog: 'Перша версія' }])
    const t = await libraryTrack('Трек збереження', m.id)
    const g = await tr.putGraph(ctx(), t.trajectoryId, {
      nodes: [
        { id: t.startId, kind: 'start', x: 0, y: 0 },
        { id: t.finishId, kind: 'finish', x: 500, y: 0 },
        { id: t.nodeId, kind: 'task', title: 'Своя назва', contentType: 'resource', contentId: resourceForNodes, params: { dueDays: 3 }, x: 250, y: 10 } as GraphNode,
      ],
      edges: [{ fromNodeId: t.startId, toNodeId: t.nodeId, sort: 0 }, { fromNodeId: t.nodeId, toNodeId: t.finishId, sort: 0 }],
    })
    expect(g.ok).toBe(true)
    const node = await nodeOf(t.trajectoryId, t.nodeId)
    expect(node).toMatchObject({ title: 'Своя назва', x: 250, params: { dueDays: 3 } })
    expect(node.library).toMatchObject({ moduleId: m.id, version: 1 })
    expect(node.contentId).not.toBe(resourceForNodes)
    expect((await lib.getModule(asAuthor(), m.id))!.usageCount).toBe(1)
  })

  it('без library.use вставка отвергается, и полотно не сохраняется даже частично', async () => {
    const m = await moduleWithVersions('Без права', [{ blocks: [text('b1', '<p>x</p>')], changelog: 'Перша версія' }])
    const t = await tr.createTrajectory(ctx(), { title: `${P}Трек без права`, tags: [] })
    const full = (await tr.getTrajectory(ctx(), t.id))!
    const r = await tr.putGraph(ctx(), t.id, {
      nodes: [...full.nodes.map(n => ({ id: n.id, kind: n.kind as 'start', x: 0, y: 0 })), { tmpId: 'tmp:lib', kind: 'task', libraryModuleId: m.id, params: {}, x: 0, y: 0 } as GraphNode],
      edges: [],
    })
    expect(r).toMatchObject({ ok: false, code: 'library', libraryCode: 'forbidden', nodeRef: 'tmp:lib' })
    const [n] = await admin`select count(*)::int as n from trajectory_nodes where trajectory_id = ${t.id}`
    expect(n!.n).toBe(2) // только автосозданные Start и Finish
  })

  it('архивный модуль не вставляется; замена модуля закрывает прежнее место', async () => {
    const first = await moduleWithVersions('Перший модуль', [{ blocks: [text('b1', '<p>1</p>')], changelog: 'Перша версія' }])
    const second = await moduleWithVersions('Другий модуль', [{ blocks: [text('b1', '<p>2</p>')], changelog: 'Перша версія' }])
    const archived = await moduleWithVersions('Архівний модуль', [{ blocks: [text('b1', '<p>3</p>')], changelog: 'Перша версія' }])
    await lib.archiveModule(asAuthor(), archived.id, 'Застарів повністю')
    const t = await libraryTrack('Трек заміни', first.id)
    const nodes = (to: string) => [
      { id: t.startId, kind: 'start' as const, x: 0, y: 0 },
      { id: t.finishId, kind: 'finish' as const, x: 500, y: 0 },
      { id: t.nodeId, kind: 'task', libraryModuleId: to, params: {}, x: 250, y: 0 } as GraphNode,
    ]
    const edges = [{ fromNodeId: t.startId, toNodeId: t.nodeId, sort: 0 }, { fromNodeId: t.nodeId, toNodeId: t.finishId, sort: 0 }]
    expect(await tr.putGraph(ctx(), t.trajectoryId, { nodes: nodes(archived.id), edges }, { libraryUse: true }))
      .toMatchObject({ ok: false, code: 'library', libraryCode: 'module_archived' })
    expect((await nodeOf(t.trajectoryId, t.nodeId)).library!.moduleId).toBe(first.id) // откат целиком

    const g = await tr.putGraph(ctx(), t.trajectoryId, { nodes: nodes(second.id), edges }, { libraryUse: true })
    expect(g.ok).toBe(true)
    expect((await nodeOf(t.trajectoryId, t.nodeId)).library!.moduleId).toBe(second.id)
    expect((await lib.getModule(asAuthor(), first.id))!.usageCount).toBe(0)
    expect((await lib.getModule(asAuthor(), second.id))!.usageCount).toBe(1)
  })

  it('задание стало блоком «І» — место закрыто, ссылка снята', async () => {
    const m = await moduleWithVersions('Стане логікою', [{ blocks: [text('b1', '<p>x</p>')], changelog: 'Перша версія' }])
    const t = await libraryTrack('Трек логіки', m.id)
    const g = await tr.putGraph(ctx(), t.trajectoryId, {
      nodes: [{ id: t.startId, kind: 'start', x: 0, y: 0 }, { id: t.finishId, kind: 'finish', x: 0, y: 0 }, { id: t.nodeId, kind: 'and', title: 'І', x: 0, y: 0 }],
      edges: [],
    })
    expect(g.ok).toBe(true)
    const [row] = await admin`select kind, library_version_id, content_id from trajectory_nodes where id = ${t.nodeId}`
    expect(row).toMatchObject({ kind: 'and', library_version_id: null, content_id: null })
    expect((await lib.getModule(asAuthor(), m.id))!.usageCount).toBe(0)
  })

  it('опубликованная траектория с узлом-ссылкой проходит проверку полотна', async () => {
    const m = await moduleWithVersions('Перевірка полотна', [{ blocks: [text('b1', '<p>x</p>')], changelog: 'Перша версія' }])
    const t = await libraryTrack('Трек перевірки', m.id)
    expect(t.graph.ok && t.graph.problems).toEqual([])
    await lib.archiveModule(asAuthor(), m.id, 'Архів не ламає навчання')
    expect(await tr.publishTrajectory(ctx(), t.trajectoryId)).toEqual({ ok: true })
  })
})

describe('дублирование траектории копирует места (§3.4)', () => {
  it('узел-копия держит ту же версию и получает своё место в реестре', async () => {
    const m = await moduleWithVersions('Дубль', [{ blocks: [text('b1', '<p>1</p>')], changelog: 'Перша версія' }])
    const t = await libraryTrack('Трек-оригінал', m.id, { publish: true })
    await publishNext(m.id, [text('b1', '<p>2</p>')], 'Друга версія')
    const copy = await tr.duplicateTrajectory(ctx(), t.trajectoryId)
    const list = await usages.listUsages(asAuthor(), m.id)
    expect(list!.active).toHaveLength(2)
    const copied = list!.active.find(u => u.containerId === copy!.id)!
    expect(copied).toMatchObject({ version: 1, isStale: true, pinMode: 'hotfix_auto', containerTitle: `${P}Трек-оригінал (копія)` })
    expect((await lib.getModule(asAuthor(), m.id))!.usageCount).toBe(2)
    const node = (await tr.getTrajectory(ctx(), copy!.id))!.nodes.find(n => n.id === copied.holderId)!
    expect(node.library).toMatchObject({ version: 1, usageId: copied.id })
  })
})

describe('«Відʼєднати і зробити копією» у узла (§7.10)', () => {
  it('узел получает опубликованный материал с телом закреплённой версии', async () => {
    const m = await moduleWithVersions('Відʼєднаний', [{ blocks: [text('b1', '<p>Закріплена v1</p>')], changelog: 'Перша версія' }])
    const t = await libraryTrack('Трек відʼєднання', m.id)
    await publishNext(m.id, [text('b1', '<p>Нова v2</p>')], 'Друга версія')
    const r = await usages.detachUsage(asAuthor(), t.usageId)
    expect(r.ok).toBe(true)
    if (!r.ok) return
    const [node] = await admin`select library_version_id, content_type, content_id from trajectory_nodes where id = ${t.nodeId}`
    expect(node).toMatchObject({ library_version_id: null, content_type: 'resource', content_id: r.resourceId })
    const [copy] = await admin`select r.status, rv.body from resources r join resource_versions rv on rv.id = r.published_version_id where r.id = ${r.resourceId}`
    expect(copy).toMatchObject({ status: 'published', body: [text('b1', '<p>Закріплена v1</p>')] })
    expect((await lib.getModule(asAuthor(), m.id))!.usageCount).toBe(0)
    expect((await nodeOf(t.trajectoryId, t.nodeId)).library).toBeNull()
  })

  it('в опубликованном треке узел не отвязывается', async () => {
    const m = await moduleWithVersions('Опублікований вузол', [{ blocks: [text('b1', '<p>x</p>')], changelog: 'Перша версія' }])
    const t = await libraryTrack('Опублікований трек', m.id, { publish: true })
    expect(await usages.detachUsage(asAuthor(), t.usageId)).toEqual({ ok: false, code: 'container_published' })
  })
})

// ── Миграция 0088, сверка, дайджест ──────────────────────────────────────────────────────

describe('миграция 0088: места узлов из реестра переносятся в колонку', () => {
  it('узел PR-25 (ссылка только в реестре) начинает читать тело своей версии', async () => {
    const m = await moduleWithVersions('Старе місце', [{ blocks: [text('b1', '<p>x</p>')], changelog: 'Перша версія' }])
    const [t] = await admin`insert into trajectories (tenant_id, title, status, created_by) values (${tenantId}, ${`${P}Трек PR-25`}, 'draft', ${adminId}) returning id`
    const [n] = await admin`insert into trajectory_nodes (tenant_id, trajectory_id, kind, title, content_type, content_id) values (${tenantId}, ${t!.id}, 'task', 'Інструкція', 'resource', ${resourceForNodes}) returning id`
    await admin`insert into library_module_usages (tenant_id, library_module_id, version_id, holder_type, holder_id, container_type, container_id, container_title, attached_by)
      values (${tenantId}, ${m.id}, ${m.versions[0]!}, 'trajectory_node', ${n!.id}, 'trajectory', ${t!.id}, 'Трек PR-25', ${authorId})`
    const sqlText = readFileSync('server/db/migrations/0088_v2_library_trajectory.sql', 'utf8')
    const backfill = sqlText.slice(sqlText.indexOf('UPDATE "trajectory_nodes" n'), sqlText.indexOf(';--> statement-breakpoint', sqlText.indexOf('UPDATE "trajectory_nodes" n')))
    await admin.unsafe(backfill)
    const [row] = await admin`select n.library_version_id, n.content_type, n.content_id, l.item_id as body
      from trajectory_nodes n join library_module_versions v on v.id = n.library_version_id join lessons l on l.id = v.lesson_id where n.id = ${n!.id}`
    expect(row).toMatchObject({ library_version_id: m.versions[0], content_type: 'resource' })
    expect(row!.content_id).toBe(row!.body)
  })

  it('поисковый вектор пересобирается по телу текущей версии (триггер на current_version_id)', async () => {
    const m = await moduleWithVersions('Тригер пошуку', [{ blocks: [text('b1', '<p>дезінфекція поверхонь</p>')], changelog: 'Перша версія' }])
    const [row] = await admin`select search_tsv::text as tsv from library_modules where id = ${m.id}`
    expect(row!.tsv).toContain('дезінфекція')
  })
})

describe('сверка и дайджест', () => {
  it('место узла, потерявшего ссылку мимо сервиса, сверка закрывает', async () => {
    const m = await moduleWithVersions('Загублене посилання', [{ blocks: [text('b1', '<p>x</p>')], changelog: 'Перша версія' }])
    const t = await libraryTrack('Трек без посилання', m.id)
    await admin`update trajectory_nodes set library_version_id = null where id = ${t.nodeId}`
    const s = await usages.usageRecalc(tenantId)
    expect(s.detached).toBeGreaterThanOrEqual(1)
    expect((await lib.getModule(asAuthor(), m.id))!.usageCount).toBe(0)
  })

  it('дайджест: одно уведомление автору в неделю с суммой устаревших ссылок', async () => {
    await admin`delete from notifications where tenant_id = ${tenantId} and code = 'library_stale_digest'`
    const [stale] = await admin`select count(*)::int as n from library_module_usages u join trajectories t on t.id = u.container_id
      where u.tenant_id = ${tenantId} and u.detached_at is null and u.is_stale and coalesce(t.created_by, t.updated_by) = ${adminId}`
    expect(stale!.n).toBeGreaterThan(0)
    const at = new Date('2026-09-28T06:00:00Z')
    const first = await usages.staleDigest(tenantId, at)
    expect(first.authors).toBeGreaterThanOrEqual(1)
    const [n] = await admin`select payload from notifications where tenant_id = ${tenantId} and user_id = ${adminId} and code = 'library_stale_digest'`
    expect(n!.payload).toMatchObject({ n: stale!.n })
    const second = await usages.staleDigest(tenantId, new Date('2026-09-30T06:00:00Z'))
    expect(second.authors).toBe(0)
    expect(usages.weekKey(at)).toBe('2026-09-28')
  })
})
