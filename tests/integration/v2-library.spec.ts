import postgres from 'postgres'
import { afterAll, beforeAll, describe, expect, it } from 'vitest'

/**
 * PR-25 пакета `docs/v2` (`45-plan.md`): библиотека модулей и версии (`31-module-library.md`,
 * патч П-11).
 *
 * Условия выхода PR-25:
 * - `lessons.module_id` nullable, `lessons_owner_ck` на месте, **ни одного урока без владельца**;
 * - удаление модуля, использованного в трёх треках, даёт `409` (здесь — вердикт сервиса,
 *   код ответа — `v2-library-http.spec.ts`).
 *
 * Критерии приёмки `31` §13, закреплённые за этим PR:
 * - **1** — модуль v2 в треке, автор публикует v3: место остаётся на v2 и показывает тело v2,
 *   рядом признак «Доступна нова версія v3»;
 * - **3** — модуль в 3 треках, админ удаляет: отказ со списком трёх мест, модуль цел;
 * - **4** — заархивированного модуля нет в палитре, три узла работают на своих версиях;
 * - **5** — человек с `library.use` без `library.publish` предлагает урок: `pending`, модуля нет;
 * - **9** — модуль чужого тенанта по id «не найден».
 *
 * Плюс то, что PR-25 обязан не сломать: урок курса как место использования (публикация курса
 * его не перезакрепляет, черновая копия курса ведёт место за собой, правка тела отвергается),
 * тело модуля не видно в библиотеке ресурсов, медиа версии не удаляется, ночная сверка.
 */

process.env.ENCRYPTION_KEY ??= 'test-encryption-key'

const lib = await import('../../server/services/library')
const usages = await import('../../server/services/libraryUsages')
const proposals = await import('../../server/services/libraryProposals')
const { setEmbeddingProvider, stubEmbeddingProvider } = await import('../../server/services/embeddings')
const { createCourse, addModule, addLesson, publishCourse, getCourseEditor, updateLesson, deleteLesson } = await import('../../server/services/courses')
const { createTrajectory, putGraph } = await import('../../server/services/trajectories')
const { listResources } = await import('../../server/services/resources')
const { softDeleteMedia } = await import('../../server/services/media')
const { withTenant } = await import('../../server/utils/withTenant')
const { SYSTEM_ROLES } = await import('../../shared/domain/roles')

type Actor = Awaited<ReturnType<typeof lib.libraryActorOf>>

const admin = postgres(process.env.DATABASE_ADMIN_URL!, { max: 2, onnotice: () => {} })
const P = 'v2-25 '

let tenantId: string
let otherTenantId: string
let adminId: string
let authorId: string
let mentorId: string
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
  // PR-26: узел-ссылка держит версию (restrict) — снять ссылку до удаления версий
  await admin`update trajectory_nodes set library_version_id = null where tenant_id in ${admin(tenants)} and library_version_id is not null`
  await admin`delete from library_module_versions where tenant_id in ${admin(tenants)}`
  await admin`delete from lessons where tenant_id in ${admin(tenants)} and library_module_id is not null`
  await admin`delete from library_modules where tenant_id in ${admin(tenants)}`
  await admin`delete from trajectories where tenant_id = ${tenantId} and title like ${`${P}%`}`
  const courses = await admin`select id from courses where tenant_id = ${tenantId} and title like ${`${P}%`}`
  if (courses.length) {
    await admin`delete from enrollments where subject_id in ${admin(courses.map(c => c.id as string))}`
    await admin`delete from courses where id in ${admin(courses.map(c => c.id as string))}`
  }
  await admin`delete from resources where tenant_id = ${tenantId} and (title like ${`${P}%`} or slug like 'library-v2-25%')`
  await admin`delete from media_assets where tenant_id = ${tenantId} and original_name like ${`${P}%`}`
  await admin`delete from notifications where tenant_id = ${tenantId} and code like 'library_%'`
}

beforeAll(async () => {
  tenantId = (await admin`select id from tenants where slug = 'kappi'`)[0]!.id as string
  const [other] = await admin`insert into tenants (slug, name) values ('test-library-isolation', 'Тест ізоляції бібліотеки')
    on conflict (slug) do update set name = excluded.name returning id`
  otherTenantId = other!.id as string
  const pick = async (phone: string) => (await admin`select id from users where tenant_id = ${tenantId} and phone = ${phone}`)[0]!.id as string
  adminId = await pick('+380661864742')
  authorId = await pick('+380670000001')
  mentorId = await pick('+380670000002')
  resourceForNodes = (await admin`select id from resources where tenant_id = ${tenantId} and status = 'published' order by created_at limit 1`)[0]!.id as string
  setEmbeddingProvider(stubEmbeddingProvider(768))
  await cleanup()
})

afterAll(async () => {
  setEmbeddingProvider(null)
  await cleanup()
  await admin`delete from tenants where id = ${otherTenantId}`
  await admin.end()
})

/** Опубликованный модуль с телом из одного блока; автор — методист. */
async function publishedModule(title: string, html = '<p>Розводимо засіб 1:10.</p>') {
  const created = await lib.createModule(asAuthor(), { title: `${P}${title}`, contentKind: 'article', tags: [], coauthorIds: [], language: 'uk', body: [text('b1', html)] })
  if (!created.ok) throw new Error(created.code)
  const v = await lib.publishVersion(asAuthor(), created.module.id, { changelog: 'Перша версія', isHotfix: false, notify: false })
  if (!v.ok) throw new Error(v.code)
  return created.module.id
}

/** Черновая траектория с одним узлом-заданием — держатель места использования. */
async function trackWithTask(title: string) {
  // Автор трека — администратор, а публикует методист: так уведомление автору контейнера видно (§8)
  const [t] = await admin`insert into trajectories (tenant_id, title, status, created_by) values (${tenantId}, ${`${P}${title}`}, 'draft', ${adminId}) returning id`
  const [n] = await admin`insert into trajectory_nodes (tenant_id, trajectory_id, kind, title, content_type, content_id)
    values (${tenantId}, ${t!.id}, 'task', 'Інструкція', 'resource', ${resourceForNodes}) returning id`
  return { trajectoryId: t!.id as string, nodeId: n!.id as string }
}

async function attachToTrack(moduleId: string, title: string) {
  const { trajectoryId, nodeId } = await trackWithTask(title)
  const r = await usages.attachUsage(asAuthor(), { libraryModuleId: moduleId, holderType: 'trajectory_node', holderId: nodeId, containerType: 'trajectory', containerId: trajectoryId, pinMode: 'hotfix_auto' })
  if (!r.ok) throw new Error(r.code)
  return r.usage
}

// ── Условия выхода: П-11 и владение урока ─────────────────────────────────────────────

describe('П-11: урок принадлежит ровно одному владельцу', () => {
  it('lessons.module_id nullable, три констрейнта библиотеки на месте', async () => {
    const [col] = await admin`select is_nullable from information_schema.columns where table_name = 'lessons' and column_name = 'module_id'`
    expect(col!.is_nullable).toBe('YES')
    const cons = await admin`select conname from pg_constraint where conrelid = 'lessons'::regclass and contype = 'c' and conname like 'lessons_%_ck' order by conname`
    expect(cons.map(c => c.conname)).toEqual(['lessons_library_body_ck', 'lessons_library_ref_ck', 'lessons_owner_ck'])
  })

  it('ни одного урока без владельца и ни одного с двумя — на живых данных', async () => {
    await publishedModule('Власник')
    const [row] = await admin`select count(*)::int as n from lessons where (module_id is not null)::int + (library_module_id is not null)::int <> 1`
    expect(row!.n).toBe(0)
  })

  it('урок без владельца и урок с двумя владельцами БД не принимает', async () => {
    const resourceId = resourceForNodes
    await expect(admin`insert into lessons (tenant_id, title, sort, item_type, item_id) values (${tenantId}, 'Нічий', 0, 'resource', ${resourceId})`)
      .rejects.toMatchObject({ code: '23514', constraint_name: 'lessons_owner_ck' })
    const [mod] = await admin`select id from modules where tenant_id = ${tenantId} limit 1`
    const [lm] = await admin`select id from library_modules where tenant_id = ${tenantId} limit 1`
    await expect(admin`insert into lessons (tenant_id, module_id, library_module_id, title, sort, item_type, item_id) values (${tenantId}, ${mod!.id}, ${lm!.id}, 'Двічі', 0, 'resource', ${resourceId})`)
      .rejects.toMatchObject({ code: '23514', constraint_name: 'lessons_owner_ck' })
  })

  it('место использования без закреплённого снимка БД не принимает (lessons_library_ref_ck)', async () => {
    const [mod] = await admin`select id from modules where tenant_id = ${tenantId} limit 1`
    const [v] = await admin`select id from library_module_versions where tenant_id = ${tenantId} limit 1`
    await expect(admin`insert into lessons (tenant_id, module_id, library_version_id, title, sort, item_type, item_id) values (${tenantId}, ${mod!.id}, ${v!.id}, 'Без знімка', 0, 'resource', ${resourceForNodes})`)
      .rejects.toMatchObject({ code: '23514', constraint_name: 'lessons_library_ref_ck' })
  })
})

// ── Карточка, версии, права ───────────────────────────────────────────────────────────

describe('модуль: черновик, версии, права (§4, §6, §7.12)', () => {
  it('методист создаёт черновик: тело — урок модуля и материал, который библиотека ресурсов не видит', async () => {
    const r = await lib.createModule(asAuthor(), { title: `${P}Прибирання залу`, contentKind: 'article', tags: ['прибирання'], coauthorIds: [], language: 'uk', body: [text('b1', '<p>Чисто</p>')] })
    expect(r.ok).toBe(true)
    if (!r.ok) return
    expect(r.module).toMatchObject({ status: 'draft', usageCount: 0, currentVersion: null, ownerId: authorId, authorIds: [authorId], canEdit: true })
    expect(r.module.draft!.body).toHaveLength(1)
    const [draft] = await admin`select l.module_id, l.library_module_id, r.status, r.id as resource_id from library_modules m
      join lessons l on l.id = m.draft_lesson_id join resources r on r.id = l.item_id where m.id = ${r.module.id}`
    expect(draft!.module_id).toBeNull()
    expect(draft!.library_module_id).toBe(r.module.id)
    expect(draft!.status).toBe('draft')
    const listed = await listResources({ tenantId, actorId: authorId }, { status: 'all', page: 1, perPage: 100, q: `${P}Прибирання` })
    expect(listed.items.map(i => i.id)).not.toContain(draft!.resource_id)
  })

  it('без library.publish модуль не создаётся (критерий 5: только предложение)', async () => {
    const r = await lib.createModule(asMentor(), { title: `${P}Від наставника`, contentKind: 'article', tags: [], coauthorIds: [], language: 'uk', body: [] })
    expect(r).toEqual({ ok: false, code: 'forbidden' })
  })

  it('пустой article не публикуется; первая версия переводит модуль в published', async () => {
    const created = await lib.createModule(asAuthor(), { title: `${P}Порожній`, contentKind: 'article', tags: [], coauthorIds: [], language: 'uk', body: [] })
    if (!created.ok) throw new Error(created.code)
    expect(await lib.publishVersion(asAuthor(), created.module.id, { changelog: 'Перша версія', isHotfix: false, notify: false })).toEqual({ ok: false, code: 'empty_body' })
    await lib.updateModule(asAuthor(), created.module.id, { body: [text('b1', '<p>Тепер є текст</p>')] })
    const v1 = await lib.publishVersion(asAuthor(), created.module.id, { changelog: 'Перша версія', isHotfix: false, notify: false })
    expect(v1.ok).toBe(true)
    if (!v1.ok) return
    expect(v1.version.version).toBe(1)
    expect(v1.version.diff).toEqual({ added: ['b1'], removed: [], changed: [] })
    const m = await lib.getModule(asAuthor(), created.module.id)
    expect(m).toMatchObject({ status: 'published', hasUnpublishedChanges: false })
    expect(m!.currentVersion!.version).toBe(1)
  })

  it('версию ждали другую — 409 version_conflict, а не молчаливая v2 (§12)', async () => {
    const id = await publishedModule('Паралельна публікація')
    const r = await lib.publishVersion(asAuthor(), id, { changelog: 'Моя правка', isHotfix: false, notify: false, expectedVersion: 1 })
    expect(r).toEqual({ ok: false, code: 'version_conflict', current: 1 })
    const ok = await lib.publishVersion(asAuthor(), id, { changelog: 'Моя правка', isHotfix: false, notify: false, expectedVersion: 2 })
    expect(ok.ok).toBe(true)
  })

  it('чужой модуль без library.manage не правится (§7.12), с library.manage — правится', async () => {
    const id = await publishedModule('Чужий')
    const stranger = actor(adminId, { publish: true, use: true })
    expect(await lib.updateModule(stranger, id, { summary: 'Не моє' })).toEqual({ ok: false, code: 'forbidden' })
    const manager = await lib.updateModule(asAdmin(), id, { summary: 'Адміністратор може' })
    expect(manager.ok).toBe(true)
    if (manager.ok) expect(manager.module.summary).toBe('Адміністратор може')
  })

  it('владелец — только человек с library.publish (§6.1)', async () => {
    const id = await publishedModule('Зміна власника')
    expect(await lib.updateModule(asAuthor(), id, { ownerId: mentorId })).toEqual({ ok: false, code: 'owner_forbidden' })
    const toAdmin = await lib.updateModule(asAuthor(), id, { ownerId: adminId })
    expect(toAdmin.ok).toBe(true)
    if (toAdmin.ok) expect(toAdmin.module.authorIds).toEqual([adminId, authorId])
  })

  it('системные роли §2: наставнику view+use без publish, методисту — publish, manage — только admin', () => {
    expect(SYSTEM_ROLES.mentor!.scopes).toEqual(expect.arrayContaining(['library.view', 'library.use']))
    expect(SYSTEM_ROLES.mentor!.scopes).not.toContain('library.publish')
    expect(SYSTEM_ROLES.manager!.scopes).not.toContain('library.publish')
    expect(SYSTEM_ROLES.author!.scopes).toEqual(expect.arrayContaining(['library.view', 'library.use', 'library.publish']))
    expect(SYSTEM_ROLES.author!.scopes).not.toContain('library.manage')
    expect(SYSTEM_ROLES.admin!.scopes).toContain('library.manage')
    expect(SYSTEM_ROLES.employee!.scopes.some(s => s.startsWith('library.'))).toBe(false)
  })

  it('эмбеддинг — по телу последней версии, с меткой модели; без ключа работает заглушка', async () => {
    const id = await publishedModule('Використання хімії', '<p>Правила розведення засобів для підлоги.</p>')
    expect(await lib.refreshLibraryEmbeddings(tenantId, [id])).toBe(1)
    const [row] = await admin`select vector_dims(embedding) as dims, embedding_model from library_modules where id = ${id}`
    expect(row).toMatchObject({ dims: 768, embedding_model: 'stub:hash-v1:768' })
  })
})

describe('список: ключевой курсор по (updated_at, id)', () => {
  it('27 модулей одного момента — две страницы по 25, ни пропусков, ни повторов', async () => {
    const at = '2026-09-24 10:00:00.123456+00'
    for (let i = 0; i < 27; i++) {
      await admin`insert into library_modules (tenant_id, title, slug, owner_id, author_ids, created_by, updated_at, tags)
        values (${tenantId}, ${`${P}Сторінка ${i}`}, ${`v2-25-page-${i}`}, ${authorId}, ${[authorId]}, ${authorId}, ${at}, ${['v2-25-page']})`
    }
    const first = await lib.listModules(asAuthor(), { status: 'all', tag: 'v2-25-page', limit: 25 })
    expect(first.items).toHaveLength(25)
    expect(first.total).toBe(27)
    expect(first.nextCursor).not.toBeNull()
    const second = await lib.listModules(asAuthor(), { status: 'all', tag: 'v2-25-page', limit: 25, cursor: first.nextCursor! })
    expect(second.items).toHaveLength(2)
    expect(second.nextCursor).toBeNull()
    const ids = [...first.items, ...second.items].map(m => m.id)
    expect(new Set(ids).size).toBe(27)
  })
})

// ── Критерий 1: закреплённая версия и баннер ──────────────────────────────────────────

describe('критерий 1: место на v2 после публикации v3 показывает v2 и знает про v3', () => {
  it('публикация не переключает место, а помечает его устаревшим', async () => {
    const id = await publishedModule('Мийка рук', '<p>Версія 1</p>')
    await lib.updateModule(asAuthor(), id, { body: [text('b1', '<p>Версія 2</p>')] })
    await lib.publishVersion(asAuthor(), id, { changelog: 'Друга версія', isHotfix: false, notify: false })
    const usage = await attachToTrack(id, 'Трек мийки')
    expect(usage).toMatchObject({ version: 2, latestVersion: 2, isStale: false, pinMode: 'hotfix_auto' })
    await attachToTrack(id, 'Другий трек мийки')

    await lib.updateModule(asAuthor(), id, { body: [text('b1', '<p>Версія 3</p>'), text('b2', '<p>Новий блок</p>')] })
    const v3 = await lib.publishVersion(asAuthor(), id, { changelog: 'Третя версія: новий блок', isHotfix: false, notify: true })
    expect(v3.ok).toBe(true)
    if (!v3.ok) return
    expect(v3.staleUsages).toBe(2)
    expect(v3.version.diff).toEqual({ added: ['b2'], removed: [], changed: ['b1'] })

    const list = await usages.listUsages(asAuthor(), id)
    expect(list!.active).toHaveLength(2)
    for (const u of list!.active) expect(u).toMatchObject({ version: 2, latestVersion: 3, isStale: true })
    const pinned = await lib.getVersion(asAuthor(), id, list!.active[0]!.version)
    expect(pinned!.body).toEqual([text('b1', '<p>Версія 2</p>')])
    const latest = await lib.getVersion(asAuthor(), id, 3)
    expect(latest!.body).toHaveLength(2)

    // §12: автор двух треков получает одно уведомление о v3, а не по одному на место
    const sent = await admin`select user_id, payload from notifications where tenant_id = ${tenantId} and code = 'library_module_updated' and dedup_key like ${`library_module_updated:${id}:3:%`}`
    expect(sent.map(r => r.user_id)).toEqual([adminId])
    expect(sent[0]!.payload).toMatchObject({ version: 3, changelog: 'Третя версія: новий блок' })
  })
})

// ── Критерии 3 и 4: удаление и архив ──────────────────────────────────────────────────

describe('критерии 3 и 4: модуль в трёх треках', () => {
  let id: string

  beforeAll(async () => {
    id = await publishedModule('Техніка безпеки')
    for (const n of [1, 2, 3]) await attachToTrack(id, `Трек безпеки ${n}`)
  })

  it('usage_count = 3; держатель повторно не подключается (§7.15)', async () => {
    const m = await lib.getModule(asAdmin(), id)
    expect(m!.usageCount).toBe(3)
    const [u] = (await usages.listUsages(asAdmin(), id))!.active
    const again = await usages.attachUsage(asAuthor(), { libraryModuleId: id, holderType: 'trajectory_node', holderId: u!.holderId, containerType: 'trajectory', containerId: u!.containerId, pinMode: 'fixed' })
    expect(again).toEqual({ ok: false, code: 'already_attached' })
  })

  it('критерий 3: удаление даёт отказ со списком трёх мест и предложением архива, модуль цел', async () => {
    const r = await lib.deleteModule(asAdmin(), id)
    expect(r.ok).toBe(false)
    if (r.ok || r.code !== 'in_use') throw new Error('ожидался in_use')
    expect(r.reason).toBe('active_usages')
    expect(r.total).toBe(3)
    expect(r.usages).toHaveLength(3)
    expect(r.usages.map(u => u.containerTitle).sort()).toEqual([1, 2, 3].map(n => `${P}Трек безпеки ${n}`))
    expect(await lib.getModule(asAdmin(), id)).not.toBeNull()
  })

  it('удалять вправе только library.manage', async () => {
    expect(await lib.deleteModule(asAuthor(), id)).toEqual({ ok: false, code: 'forbidden' })
  })

  it('архив без права на модуль не ставится; с причиной — ставится', async () => {
    const stranger = actor(mentorId, { publish: true })
    expect(await lib.archiveModule(stranger, id, 'Не мій модуль')).toEqual({ ok: false, code: 'forbidden' })
    const r = await lib.archiveModule(asAuthor(), id, 'Замінено новою інструкцією')
    expect(r.ok).toBe(true)
    if (r.ok) expect(r.module).toMatchObject({ status: 'archived', archiveReason: 'Замінено новою інструкцією', usageCount: 3 })
  })

  it('критерий 4: в палитре (published) и в списке по умолчанию архивного модуля нет', async () => {
    const palette = await lib.listModules(asAuthor(), { status: 'published', limit: 100 })
    expect(palette.items.map(m => m.id)).not.toContain(id)
    const byDefault = await lib.listModules(asAuthor(), { status: 'active', limit: 100 })
    expect(byDefault.items.map(m => m.id)).not.toContain(id)
    const archived = await lib.listModules(asAuthor(), { status: 'archived', limit: 100 })
    expect(archived.items.map(m => m.id)).toContain(id)
  })

  it('критерий 4: три узла работают на своих версиях — места активны, тело версии читается', async () => {
    const list = await usages.listUsages(asAuthor(), id)
    expect(list!.active).toHaveLength(3)
    expect(list!.active.every(u => u.version === 1)).toBe(true)
    const v = await lib.getVersion(asAuthor(), id, 1)
    expect(v!.body).toEqual([text('b1', '<p>Розводимо засіб 1:10.</p>')])
  })

  it('архивный модуль не вставляется, не правится и новых версий не получает (§7.6)', async () => {
    const { trajectoryId, nodeId } = await trackWithTask('Трек після архіву')
    expect(await usages.attachUsage(asAuthor(), { libraryModuleId: id, holderType: 'trajectory_node', holderId: nodeId, containerType: 'trajectory', containerId: trajectoryId, pinMode: 'hotfix_auto' }))
      .toEqual({ ok: false, code: 'module_archived' })
    expect(await lib.updateModule(asAuthor(), id, { summary: 'x' })).toEqual({ ok: false, code: 'module_archived' })
    expect(await lib.publishVersion(asAuthor(), id, { changelog: 'Після архіву', isHotfix: false, notify: false })).toEqual({ ok: false, code: 'module_archived' })
  })

  it('восстановление возвращает модуль с версией в published', async () => {
    const r = await lib.restoreModule(asAuthor(), id)
    expect(r.ok).toBe(true)
    if (r.ok) expect(r.module).toMatchObject({ status: 'published', archivedAt: null, archiveReason: null })
  })

  it('отключённые места тоже держат модуль: отвязали все три — удалить всё равно нельзя', async () => {
    for (const u of (await usages.listUsages(asAuthor(), id))!.active) expect((await usages.detachUsage(asAuthor(), u.id)).ok).toBe(true)
    expect((await lib.getModule(asAdmin(), id))!.usageCount).toBe(0)
    const r = await lib.deleteModule(asAdmin(), id)
    expect(r).toMatchObject({ ok: false, code: 'in_use', reason: 'detached_usages', total: 0, detached: 3 })
  })

  it('модуль, который ничего не держит, удаляется физически: версии, уроки, тело', async () => {
    const lonely = await publishedModule('Самотній')
    const [body] = await admin`select l.item_id from library_modules m join lessons l on l.id = m.draft_lesson_id where m.id = ${lonely}`
    expect(await lib.deleteModule(asAdmin(), lonely)).toEqual({ ok: true })
    const [left] = await admin`select
      (select count(*)::int from library_modules where id = ${lonely}) as modules,
      (select count(*)::int from library_module_versions where library_module_id = ${lonely}) as versions,
      (select count(*)::int from lessons where library_module_id = ${lonely}) as lessons,
      (select deleted_at is not null from resources where id = ${body!.item_id}) as body_deleted`
    expect(left).toMatchObject({ modules: 0, versions: 0, lessons: 0, body_deleted: true })
  })
})

// ── Критерий 5: предложение вместо модуля ─────────────────────────────────────────────

describe('критерий 5: library.use без library.publish — предложение, а не модуль', () => {
  let lessonId: string

  beforeAll(async () => {
    const c = await createCourse({ tenantId, actorId: authorId }, { title: `${P}Курс пропозицій`, language: 'uk', strictOrder: true, isCatalogVisible: false, tags: [] })
    const mod = await addModule({ tenantId, actorId: authorId }, c.id, 'Розділ')
    const l = await addLesson({ tenantId, actorId: authorId }, { moduleId: mod!.id, title: `${P}Урок про засоби`, itemType: 'resource', resource: { body: [text('p1', '<p>Засоби для кухні</p>')] }, isRequired: true, videoThresholdPct: 90 })
    if (!l.ok) throw new Error(l.code)
    lessonId = l.lesson.id
  })

  it('наставник предлагает урок: pending, модулей не прибавилось, кураторам — уведомление', async () => {
    const [before] = await admin`select count(*)::int as n from library_modules where tenant_id = ${tenantId}`
    const r = await proposals.createProposal(asMentor(), { sourceLessonId: lessonId, comment: 'Потрібно в кожному онбордингу' })
    expect(r.ok).toBe(true)
    if (!r.ok) return
    expect(r.proposal).toMatchObject({ status: 'pending', proposedTitle: `${P}Урок про засоби`, sourceContainerType: 'course' })
    const [after] = await admin`select count(*)::int as n from library_modules where tenant_id = ${tenantId}`
    expect(after!.n).toBe(before!.n)
    const [n] = await admin`select count(*)::int as n from notifications where code = 'library_proposal_created' and ref_id = ${r.proposal.id}`
    expect(n!.n).toBeGreaterThan(0)
  })

  it('повторная подача по тому же уроку — proposal_pending (§6.3)', async () => {
    expect(await proposals.createProposal(asMentor(), { sourceLessonId: lessonId, comment: 'Ще раз' })).toEqual({ ok: false, code: 'proposal_pending' })
  })

  it('наставник видит только свои предложения, куратор — все', async () => {
    expect((await proposals.listProposals(asMentor(), {})).every(p => p.proposedBy.id === mentorId)).toBe(true)
    expect((await proposals.listProposals(asAuthor(), { status: 'pending' })).some(p => p.sourceLessonId === lessonId)).toBe(true)
  })

  it('принять может только куратор; принятие создаёт черновик с копией тела урока', async () => {
    const [p] = await proposals.listProposals(asAuthor(), { status: 'pending' })
    expect(await proposals.acceptProposal(asMentor(), p!.id, {})).toEqual({ ok: false, code: 'forbidden' })
    const r = await proposals.acceptProposal(asAuthor(), p!.id, {})
    expect(r.ok).toBe(true)
    if (!r.ok) return
    const m = await lib.getModule(asAuthor(), r.libraryModuleId!)
    expect(m).toMatchObject({ status: 'draft', ownerId: authorId, title: `${P}Урок про засоби` })
    expect(m!.draft!.body).toEqual([text('p1', '<p>Засоби для кухні</p>')])
    expect(await proposals.rejectProposal(asAuthor(), p!.id, 'Уже прийнято раніше')).toEqual({ ok: false, code: 'already_decided' })
  })

  it('отказ — с комментарием; своё ожидающее предложение автор может отозвать', async () => {
    const first = await proposals.createProposal(asMentor(), { sourceLessonId: lessonId, comment: 'Спроба два' })
    if (!first.ok) throw new Error(first.code)
    const rejected = await proposals.rejectProposal(asAuthor(), first.proposal.id, 'Дублює наявний модуль')
    expect(rejected.ok && rejected.proposal).toMatchObject({ status: 'rejected', decisionComment: 'Дублює наявний модуль' })
    const second = await proposals.createProposal(asMentor(), { sourceLessonId: lessonId, comment: 'Спроба три' })
    if (!second.ok) throw new Error(second.code)
    const withdrawn = await proposals.withdrawProposal(asMentor(), second.proposal.id)
    expect(withdrawn.ok && withdrawn.proposal.status).toBe('withdrawn')
  })
})

// ── Критерий 9: чужой тенант ──────────────────────────────────────────────────────────

describe('критерий 9: модуль чужого тенанта с тем же кодом — «не найден»', () => {
  it('тот же slug в двух тенантах допустим, чужой модуль по id не находится ни одной операцией', async () => {
    const mine = await lib.createModule(asAuthor(), { title: `${P}Спільний код`, slug: 'v2-25-shared-slug', contentKind: 'article', tags: [], coauthorIds: [], language: 'uk', body: [] })
    expect(mine.ok).toBe(true)
    const [foreign] = await admin`insert into library_modules (tenant_id, title, slug, owner_id, author_ids, created_by)
      values (${otherTenantId}, 'Чужий модуль', 'v2-25-shared-slug', ${adminId}, ${[adminId]}, ${adminId}) returning id`
    const id = foreign!.id as string
    expect(await lib.getModule(asAdmin(), id)).toBeNull()
    expect(await lib.listVersions(asAdmin(), id)).toBeNull()
    expect(await usages.listUsages(asAdmin(), id)).toBeNull()
    expect(await lib.updateModule(asAdmin(), id, { summary: 'x' })).toEqual({ ok: false, code: 'not_found' })
    expect(await lib.archiveModule(asAdmin(), id, 'Спроба чужого')).toEqual({ ok: false, code: 'not_found' })
    expect(await lib.deleteModule(asAdmin(), id)).toEqual({ ok: false, code: 'not_found' })
    const [still] = await admin`select title from library_modules where id = ${id}`
    expect(still!.title).toBe('Чужий модуль')
  })

  it('RLS: под своим тенантом виден только свой модуль, под чужим — только чужой', async () => {
    const { sql } = await import('drizzle-orm')
    const seen = async (t: string) => (await withTenant(t, null, tx => tx.execute(sql`select tenant_id, slug from library_modules where slug = 'v2-25-shared-slug'`))) as unknown as { tenant_id: string }[]
    expect((await seen(tenantId)).map(r => r.tenant_id)).toEqual([tenantId])
    expect((await seen(otherTenantId)).map(r => r.tenant_id)).toEqual([otherTenantId])
  })
})

// ── Урок курса как место использования ────────────────────────────────────────────────

describe('урок курса как место использования (§3.1, §7.1–§7.3, §7.10)', () => {
  let moduleId: string
  let courseId: string
  let lessonId: string

  beforeAll(async () => {
    moduleId = await publishedModule('Модуль у курсі', '<p>Текст v1</p>')
    const c = await createCourse({ tenantId, actorId: authorId }, { title: `${P}Курс із модулем`, language: 'uk', strictOrder: true, isCatalogVisible: false, tags: [] })
    courseId = c.id
    const mod = await addModule({ tenantId, actorId: authorId }, c.id, 'Розділ')
    const l = await addLesson({ tenantId, actorId: authorId }, { moduleId: mod!.id, title: `${P}Урок-місце`, itemType: 'resource', resource: { body: [text('own', '<p>Свій текст</p>')] }, isRequired: true, videoThresholdPct: 90 })
    if (!l.ok) throw new Error(l.code)
    lessonId = l.lesson.id
  })

  it('без course.edit вставить нельзя (container_forbidden): у наставника library.use есть, права на курс — нет', async () => {
    expect(await usages.attachUsage(asMentor(), { libraryModuleId: moduleId, holderType: 'course_lesson', holderId: lessonId, containerType: 'course', containerId: courseId, pinMode: 'fixed' }))
      .toEqual({ ok: false, code: 'container_forbidden' })
  })

  it('вставка делает урок ссылкой на снимок v1: своего материала нет, редактор показывает v1', async () => {
    const r = await usages.attachUsage(asAuthor(), { libraryModuleId: moduleId, holderType: 'course_lesson', holderId: lessonId, containerType: 'course', containerId: courseId, pinMode: 'fixed' })
    expect(r.ok).toBe(true)
    const [l] = await admin`select library_version_id, resource_version_id from lessons where id = ${lessonId}`
    expect(l!.library_version_id).not.toBeNull()
    expect(l!.resource_version_id).not.toBeNull()
    const editor = await getCourseEditor({ tenantId, actorId: authorId }, courseId)
    const lesson = editor!.modules[0]!.lessons[0]!
    expect(lesson.body).toEqual([text('b1', '<p>Текст v1</p>')])
    expect(lesson.library).toMatchObject({ moduleId, version: 1, isStale: false })
  })

  it('тело урока-ссылки не правится планом курса — «Це посилання на модуль бібліотеки»', async () => {
    expect(await updateLesson({ tenantId, actorId: authorId }, lessonId, { body: [text('x', '<p>Правка</p>')] })).toEqual({ ok: false, code: 'library_reference' })
    const renamed = await updateLesson({ tenantId, actorId: authorId }, lessonId, { title: `${P}Урок-місце (нова назва)` })
    expect(renamed.ok).toBe(true)
    const [m] = await admin`select r.title from library_modules m join lessons l on l.id = m.draft_lesson_id join resources r on r.id = l.item_id where m.id = ${moduleId}`
    expect(m!.title).toBe(`${P}Модуль у курсі`) // тело модуля не переименовано уроком курса
  })

  it('урок модуля по прямой ссылке /lessons/:id «не найден»: ни правки, ни удаления', async () => {
    const [draft] = await admin`select draft_lesson_id from library_modules where id = ${moduleId}`
    expect(await updateLesson({ tenantId, actorId: authorId }, draft!.draft_lesson_id as string, { title: 'Злам' })).toEqual({ ok: false, code: 'not_found' })
    expect(await deleteLesson({ tenantId, actorId: authorId }, draft!.draft_lesson_id as string)).toBeNull()
  })

  it('публикация v2 модуля и публикация курса не перезакрепляют урок: он остаётся на v1', async () => {
    await lib.updateModule(asAuthor(), moduleId, { body: [text('b1', '<p>Текст v2</p>')] })
    await lib.publishVersion(asAuthor(), moduleId, { changelog: 'Друга версія', isHotfix: false, notify: false })
    const [before] = await admin`select resource_version_id from lessons where id = ${lessonId}`
    const pub = await publishCourse({ tenantId, actorId: authorId }, courseId, 'Курс з бібліотекою')
    expect(pub.ok).toBe(true)
    const [after] = await admin`select resource_version_id from lessons where id = ${lessonId}`
    expect(after!.resource_version_id).toBe(before!.resource_version_id)
    const [snap] = await admin`select body from resource_versions where id = ${after!.resource_version_id}`
    expect(snap!.body).toEqual([text('b1', '<p>Текст v1</p>')])
  })

  it('черновая копия курса ведёт место за собой, урок опубликованной версии хранит ссылку', async () => {
    const editor = await getCourseEditor({ tenantId, actorId: authorId }, courseId) // ensureDraftVersion
    const draftLesson = editor!.modules[0]!.lessons[0]!
    expect(draftLesson.id).not.toBe(lessonId)
    expect(draftLesson.library).toMatchObject({ version: 1, latestVersion: 2, isStale: true })
    const list = await usages.listUsages(asAuthor(), moduleId)
    expect(list!.active.map(u => u.holderId)).toEqual([draftLesson.id])
    const [published] = await admin`select library_version_id from lessons where id = ${lessonId}`
    expect(published!.library_version_id).not.toBeNull()
    lessonId = draftLesson.id
  })

  it('отвязка делает копию тела закреплённой версии: урок получает свой материал', async () => {
    const [u] = (await usages.listUsages(asAuthor(), moduleId))!.active
    const r = await usages.detachUsage(asAuthor(), u!.id)
    expect(r).toEqual({ ok: true, lessonId, resourceId: null })
    const [l] = await admin`select l.library_version_id, l.resource_version_id, r.body, r.status from lessons l join resources r on r.id = l.item_id where l.id = ${lessonId}`
    expect(l).toMatchObject({ library_version_id: null, resource_version_id: null, status: 'draft' })
    expect(l!.body).toEqual([text('b1', '<p>Текст v1</p>')])
    expect((await lib.getModule(asAuthor(), moduleId))!.usageCount).toBe(0)
    expect(await usages.detachUsage(asAuthor(), u!.id)).toEqual({ ok: false, code: 'already_detached' })
  })

  it('удаление урока-ссылки из плана закрывает место (§12)', async () => {
    const r = await usages.attachUsage(asAuthor(), { libraryModuleId: moduleId, holderType: 'course_lesson', holderId: lessonId, containerType: 'course', containerId: courseId, pinMode: 'fixed' })
    expect(r.ok).toBe(true)
    expect((await lib.getModule(asAuthor(), moduleId))!.usageCount).toBe(1)
    expect(await deleteLesson({ tenantId, actorId: authorId }, lessonId)).not.toBeNull()
    expect((await lib.getModule(asAuthor(), moduleId))!.usageCount).toBe(0)
    const list = await usages.listUsages(asAuthor(), moduleId, { includeDetached: true })
    expect(list!.active).toHaveLength(0)
    expect(list!.detached.length).toBeGreaterThanOrEqual(2)
  })
})

// ── Узел траектории, медиа версии, ночная сверка ──────────────────────────────────────

describe('узел, медиа, сверка', () => {
  it('узел удалён с полотна — место закрыто, usage_count уменьшился', async () => {
    const id = await publishedModule('Модуль на полотні')
    const t = await createTrajectory({ tenantId, actorId: authorId }, { title: `${P}Полотно`, tags: [] })
    const g1 = await putGraph({ tenantId, actorId: authorId }, t.id, {
      nodes: [...(await admin`select id, kind from trajectory_nodes where trajectory_id = ${t.id}`).map(n => ({ id: n.id as string, kind: n.kind as 'start', x: 0, y: 0 })),
        { tmpId: 'tmp:task', kind: 'task', contentType: 'resource', contentId: resourceForNodes, params: {}, x: 10, y: 10 }],
      edges: [],
    })
    if (!g1.ok) throw new Error(g1.code)
    const nodeId = g1.ids['tmp:task']!
    const attached = await usages.attachUsage(asAuthor(), { libraryModuleId: id, holderType: 'trajectory_node', holderId: nodeId, containerType: 'trajectory', containerId: t.id, pinMode: 'hotfix_auto' })
    expect(attached.ok).toBe(true)
    expect((await lib.getModule(asAuthor(), id))!.usageCount).toBe(1)

    const g2 = await putGraph({ tenantId, actorId: authorId }, t.id, {
      nodes: g1.nodes.filter(n => n.id !== nodeId).map(n => ({ id: n.id, kind: n.kind as 'start', x: 0, y: 0 })),
      edges: [],
    })
    expect(g2.ok).toBe(true)
    expect((await lib.getModule(asAuthor(), id))!.usageCount).toBe(0)
    const list = await usages.listUsages(asAuthor(), id, { includeDetached: true })
    expect(list!.detached.map(u => u.holderId)).toEqual([nodeId])
  })

  it('в узел логики графа модуль не вставляется; в опубликованный трек — тоже', async () => {
    const id = await publishedModule('Не в логіку')
    const { trajectoryId } = await trackWithTask('Трек логіки')
    const [and] = await admin`insert into trajectory_nodes (tenant_id, trajectory_id, kind, title) values (${tenantId}, ${trajectoryId}, 'and', 'І') returning id`
    expect(await usages.attachUsage(asAuthor(), { libraryModuleId: id, holderType: 'trajectory_node', holderId: and!.id as string, containerType: 'trajectory', containerId: trajectoryId, pinMode: 'fixed' }))
      .toEqual({ ok: false, code: 'holder_not_content' })
    const pub = await trackWithTask('Опублікований трек')
    await admin`update trajectories set status = 'published' where id = ${pub.trajectoryId}`
    expect(await usages.attachUsage(asAuthor(), { libraryModuleId: id, holderType: 'trajectory_node', holderId: pub.nodeId, containerType: 'trajectory', containerId: pub.trajectoryId, pinMode: 'fixed' }))
      .toEqual({ ok: false, code: 'container_published' })
  })

  it('медиа, которое держит опубликованная версия, не удаляется (§7.13)', async () => {
    const [m] = await admin`insert into media_assets (tenant_id, key, original_name, kind, mime, bytes, status, origin)
      values (${tenantId}, ${`t/${tenantId}/test/${crypto.randomUUID()}.png`}, ${`${P}схема.png`}, 'image', 'image/png', 1000, 'ready', 'lesson_attachment') returning id`
    const mediaId = m!.id as string
    const created = await lib.createModule(asAuthor(), { title: `${P}З картинкою`, contentKind: 'article', tags: [], coauthorIds: [], language: 'uk',
      body: [{ id: 'img', type: 'image', mediaId, alt: 'Схема розведення', width: 'full' }] })
    if (!created.ok) throw new Error(created.code)
    const v = await lib.publishVersion(asAuthor(), created.module.id, { changelog: 'З картинкою', isHotfix: false, notify: false })
    expect(v.ok).toBe(true)
    const r = await softDeleteMedia({ tenantId, actorId: adminId }, mediaId, { reason: 'прибирання' })
    expect(r).toMatchObject({ ok: false, code: 'in_library_version' })
    if (!r.ok && r.code === 'in_library_version') expect(r.versions).toEqual([{ libraryModuleId: created.module.id, title: `${P}З картинкою`, version: 1 }])
  })

  it('ночная сверка чинит usage_count и is_stale и пишет в аудит только при расхождении', async () => {
    const id = await publishedModule('Зіпсований лічильник')
    await attachToTrack(id, 'Трек лічильника')
    await admin`update library_modules set usage_count = 7 where id = ${id}`
    await admin`update library_module_usages set is_stale = true where library_module_id = ${id}`
    const s = await usages.usageRecalc(tenantId)
    expect(s.countsFixed).toBeGreaterThanOrEqual(1)
    expect(s.staleFixed).toBeGreaterThanOrEqual(1)
    expect((await lib.getModule(asAuthor(), id))!).toMatchObject({ usageCount: 1, staleUsages: 0 })
    const again = await usages.usageRecalc(tenantId)
    expect(again).toEqual({ detached: 0, staleFixed: 0, countsFixed: 0 })
  })

  it('место, чей узел исчез мимо полотна, сверка закрывает', async () => {
    const id = await publishedModule('Загублений вузол')
    const u = await attachToTrack(id, 'Трек без вузла')
    await admin`delete from trajectory_nodes where id = ${u.holderId}`
    const s = await usages.usageRecalc(tenantId)
    expect(s.detached).toBeGreaterThanOrEqual(1)
    expect((await lib.getModule(asAuthor(), id))!.usageCount).toBe(0)
  })
})
