import { randomUUID } from 'node:crypto'
import { and, desc, eq, ilike, inArray, isNotNull, isNull, or, sql, type SQL } from 'drizzle-orm'
import {
  courseCategories, courses, lessons, libraryModuleUsages, libraryModuleVersions, libraryModules,
  resourceVersions, resources, trajectories, users,
} from '../db/schema'
import type { TenantTx } from '../utils/withTenant'
import { withTenant } from '../utils/withTenant'
import { keysetAfter, keysetAt } from '../utils/keyset'
import { can, type Access } from './access'
import { effectiveRoles } from './activeRole'
import { recordAudit } from './audit'
import { slugify } from './courses'
import { embeddingProvider } from './embeddings'
import { blocksToText } from './knowledge'
import { enqueueNotification } from './notifications'
import { resourcePublishChecks } from './resources'
import { sanitizeBody } from './sanitize'
import type { ContentBlock } from '../../shared/schemas/content'
import type { ResourceKind } from '../../shared/schemas/resources'
import type {
  LibraryListQuery, LibraryModuleCreateInput, LibraryModuleUpdateInput, LibraryPublishVersionInput,
} from '../../shared/schemas/library'
import type { LibraryModuleStatus } from '../../shared/enums'
import { KEYSETS, encodeKeyset } from '../../shared/domain/keyset'
import {
  LIBRARY_LIMITS, authorIdsOf, canEditModule, deletionVerdict, diffBlocks, embeddingText, isHybridQuery, mediaIdsOf,
  prefixTsQuery, restoredStatus, rrfMerge, skippedVersions, typeIconOf,
  type BlockDiff, type LibraryActorRights, type LibraryTypeIcon,
} from '../../shared/domain/library'

/**
 * Библиотека переиспользуемых модулей — карточка, черновик, версии, архив, удаление
 * (`docs/v2/31-module-library.md` §3–§7, §10; PR-25 плана `docs/v2/45`).
 *
 * Устройство тела (`31` §3.1 в редакции PR-25): у модуля есть урок-черновик
 * (`draft_lesson_id`, `lessons.library_module_id = модуль`), который ссылается на **рабочую
 * редакцию материала** (`resources`, статус всегда `draft`, см. `libraryBody.ts`). Публикация
 * версии — это снимок материала в `resource_versions` плюс урок-снимок, чей
 * `resource_version_id` указывает на этот снимок; `library_module_versions.lesson_id` —
 * на урок-снимок. Снимок не меняется никогда: правка модуля не имеет права менять
 * содержание трека, который человек проходит сейчас (Р-31.2).
 *
 * Места использования, их вставка и отвязка — `libraryUsages.ts`; предложения —
 * `libraryProposals.ts`. Эндпоинты тонкие (CLAUDE.md п. 6): права скоупами проверяет
 * `requireScope`, а «свой/чужой модуль» (§7.12) — этот сервис по `LibraryActor`.
 */

interface Ctx { tenantId: string, actorId: string }

/** Кто действует и что ему можно в библиотеке и в контейнерах (§2). */
export interface LibraryActor extends Ctx, LibraryActorRights {
  /** `library.use` — вставлять модуль в место использования, предлагать урок. */
  use: boolean
  /** `course.edit` — править урок курса (место использования). */
  courseEdit: boolean
  /** `program.manage` — править узел траектории (место использования). */
  programManage: boolean
}

export function libraryActorOf(a: Access): LibraryActor {
  return {
    tenantId: a.tenantId,
    actorId: a.userId,
    manage: can(a, 'library.manage'),
    publish: can(a, 'library.publish'),
    use: can(a, 'library.use'),
    courseEdit: can(a, 'course.edit'),
    programManage: can(a, 'program.manage'),
  }
}

// ── Общие помощники (их же зовут libraryUsages.ts и libraryProposals.ts) ─────────────────

/** Есть ли у человека право `scope` хоть в одной действующей роли — «У цієї людини немає прав на бібліотеку» (§6.1). */
export async function holdsScope(tx: TenantTx, userId: string, scope: string): Promise<boolean> {
  return (await effectiveRoles(tx, userId)).some(r => r.scopes.includes(scope))
}

async function slugTaken(tx: TenantTx, slug: string, exceptId?: string): Promise<boolean> {
  const [row] = await tx.select({ id: libraryModules.id }).from(libraryModules)
    .where(and(eq(libraryModules.slug, slug), exceptId ? sql`${libraryModules.id} <> ${exceptId}` : undefined))
  return !!row
}

/** Код модуля из названия; занятый получает короткий хвост — код не должен ронять создание (§3.2 «по умолчанию из title»). */
export async function freeSlug(tx: TenantTx, title: string): Promise<string> {
  const base = slugify(title).slice(0, 70)
  return (await slugTaken(tx, base)) ? `${base}-${randomUUID().slice(0, 6)}` : base
}

/** Код материала-тела: внутренний, пользователю не показывается, поэтому просто уникален в тенанте. */
function bodySlug(moduleSlug: string): string {
  return `library-${moduleSlug.slice(0, 60)}-${randomUUID().slice(0, 8)}`
}

async function categoryExists(tx: TenantTx, id: string): Promise<boolean> {
  const [row] = await tx.select({ id: courseCategories.id }).from(courseCategories).where(eq(courseCategories.id, id))
  return !!row
}

export interface BodyFields {
  kind: ResourceKind
  body: ContentBlock[]
  mediaId?: string | null
  externalUrl?: string | null
}

export interface ModuleFields {
  title: string
  slug: string
  contentKind: ResourceKind
  categoryId: string | null
  tags: string[]
  summary: string | null
  estimatedMinutes: number | null
  language: string
  ownerId: string
  authorIds: string[]
}

/**
 * Новый модуль с черновиком (внутри транзакции вызывающего): материал-тело, карточка,
 * урок-черновик — и замыкание `draft_lesson_id`. Используется созданием, дублированием и
 * принятием предложения, чтобы тело заводилось одним путём.
 */
export async function insertModuleTx(tx: TenantTx, ctx: Ctx, f: ModuleFields, content: BodyFields): Promise<string> {
  const body = sanitizeBody(content.body)
  const [res] = await tx.insert(resources).values({
    tenantId: ctx.tenantId,
    title: f.title,
    slug: bodySlug(f.slug),
    kind: content.kind,
    summary: f.summary,
    body,
    plainText: blocksToText(body),
    mediaId: content.mediaId ?? null,
    externalUrl: content.externalUrl ?? null,
    language: f.language,
    estimatedMinutes: f.estimatedMinutes,
    authorIds: f.authorIds,
    status: 'draft', // тело модуля не бывает «опубликованным ресурсом» — см. libraryBody.ts
  }).returning({ id: resources.id })

  const [mod] = await tx.insert(libraryModules).values({
    tenantId: ctx.tenantId,
    title: f.title,
    slug: f.slug,
    contentKind: f.contentKind,
    categoryId: f.categoryId,
    tags: f.tags,
    summary: f.summary,
    estimatedMinutes: f.estimatedMinutes,
    language: f.language,
    ownerId: f.ownerId,
    authorIds: f.authorIds,
    status: 'draft',
    createdBy: ctx.actorId,
  }).returning({ id: libraryModules.id })

  const [draft] = await tx.insert(lessons).values({
    tenantId: ctx.tenantId,
    moduleId: null,
    libraryModuleId: mod!.id,
    title: f.title,
    sort: 0,
    itemType: 'resource',
    itemId: res!.id,
  }).returning({ id: lessons.id })

  await tx.update(libraryModules).set({ draftLessonId: draft!.id }).where(eq(libraryModules.id, mod!.id))
  return mod!.id
}

/** Урок-черновик модуля и его рабочая редакция материала. */
async function draftOf(tx: TenantTx, m: typeof libraryModules.$inferSelect) {
  if (!m.draftLessonId) return null
  const [row] = await tx.select({ lesson: lessons, resource: resources }).from(lessons)
    .innerJoin(resources, eq(resources.id, lessons.itemId))
    .where(and(eq(lessons.id, m.draftLessonId), eq(lessons.libraryModuleId, m.id)))
  return row ?? null
}

/** Снимок тела версии: урок-снимок → `resource_versions`. */
export async function versionSnapshot(tx: TenantTx, versionId: string) {
  const [row] = await tx.select({ version: libraryModuleVersions, snapshot: resourceVersions, lesson: lessons })
    .from(libraryModuleVersions)
    .innerJoin(lessons, eq(lessons.id, libraryModuleVersions.lessonId))
    .innerJoin(resourceVersions, eq(resourceVersions.id, lessons.resourceVersionId))
    .where(eq(libraryModuleVersions.id, versionId))
  return row ?? null
}

/** Авторы контейнеров, где модуль сейчас используется (§8 «кому»): курс — его автор, трек — его автор. */
export async function containerAuthors(tx: TenantTx, moduleId: string): Promise<Map<string, string[]>> {
  const rows = await tx.execute(sql`
    select distinct coalesce(c.created_by, t.created_by) as user_id, u.container_title
    from library_module_usages u
    left join courses c on u.container_type = 'course' and c.id = u.container_id
    left join trajectories t on u.container_type = 'trajectory' and t.id = u.container_id
    where u.library_module_id = ${moduleId}::uuid and u.detached_at is null
  `) as unknown as { user_id: string | null, container_title: string }[]
  const out = new Map<string, string[]>()
  for (const r of rows) {
    if (!r.user_id) continue
    out.set(r.user_id, [...(out.get(r.user_id) ?? []), r.container_title])
  }
  return out
}

// ── Карточка ─────────────────────────────────────────────────────────────────────────────

export interface LibraryVersionRef {
  id: string
  version: number
  publishedAt: Date
  changelog: string
  isHotfix: boolean
}

export interface LibraryModuleCard {
  id: string
  title: string
  slug: string
  contentKind: string
  categoryId: string | null
  categoryName: string | null
  tags: string[]
  language: string
  summary: string | null
  estimatedMinutes: number | null
  ownerId: string
  ownerName: string | null
  authorIds: string[]
  status: LibraryModuleStatus
  /**
   * Иконка колонки «Тип» и палитры (§7.7, критерий 7): `article` уточняется доминирующим блоком
   * тела последней версии (черновика — пока версий нет). `contentKind` при этом не меняется.
   */
  typeIcon: LibraryTypeIcon
  usageCount: number
  staleUsages: number
  currentVersion: LibraryVersionRef | null
  archivedAt: Date | null
  archiveReason: string | null
  createdAt: Date
  updatedAt: Date
}

type ModuleRow = typeof libraryModules.$inferSelect

/** Обогащение строк карточек: владелец, категория, текущая версия, число устаревших мест. */
async function toCards(tx: TenantTx, rows: ModuleRow[]): Promise<LibraryModuleCard[]> {
  if (!rows.length) return []
  const ids = rows.map(r => r.id)
  const ownerIds = [...new Set(rows.map(r => r.ownerId))]
  const owners = await tx.select({ id: users.id, fullName: users.fullName }).from(users).where(inArray(users.id, ownerIds))
  const ownerName = new Map(owners.map(o => [o.id, o.fullName]))
  const categoryIds = [...new Set(rows.map(r => r.categoryId).filter((v): v is string => !!v))]
  const cats = categoryIds.length ? await tx.select({ id: courseCategories.id, name: courseCategories.name }).from(courseCategories).where(inArray(courseCategories.id, categoryIds)) : []
  const catName = new Map(cats.map(c => [c.id, c.name]))
  const versionIds = rows.map(r => r.currentVersionId).filter((v): v is string => !!v)
  const versions = versionIds.length
    ? await tx.select({
        id: libraryModuleVersions.id, version: libraryModuleVersions.version, publishedAt: libraryModuleVersions.publishedAt,
        changelog: libraryModuleVersions.changelog, isHotfix: libraryModuleVersions.isHotfix,
      }).from(libraryModuleVersions).where(inArray(libraryModuleVersions.id, versionIds))
    : []
  const versionById = new Map(versions.map(v => [v.id, v]))
  const stale = await tx.select({ moduleId: libraryModuleUsages.libraryModuleId, n: sql<number>`count(*)::int` }).from(libraryModuleUsages)
    .where(and(inArray(libraryModuleUsages.libraryModuleId, ids), isNull(libraryModuleUsages.detachedAt), eq(libraryModuleUsages.isStale, true)))
    .groupBy(libraryModuleUsages.libraryModuleId)
  const staleBy = new Map(stale.map(s => [s.moduleId, s.n]))
  // §7.7: состав тела — последней версии, а пока версий нет — черновика; тела не выгружаются
  const stats = await tx.execute(sql`
    select m.id, s.blocks, s.checklists, s.has_table
    from library_modules m
    left join library_module_versions v on v.id = m.current_version_id
    left join lessons vl on vl.id = v.lesson_id
    left join resource_versions rv on rv.id = vl.resource_version_id
    left join lessons dl on dl.id = m.draft_lesson_id
    left join resources r on r.id = dl.item_id
    cross join lateral (${bodyStatsSql(sql`coalesce(rv.body, r.body, '[]'::jsonb)`)}) s
    where m.id in (${sql.join(ids.map(id => sql`${id}::uuid`), sql`, `)})
  `) as unknown as { id: string, blocks: number, checklists: number, has_table: boolean }[]
  const statsBy = new Map(stats.map(r => [r.id, { blocks: Number(r.blocks), checklists: Number(r.checklists), hasTable: !!r.has_table }]))
  return rows.map(r => ({
    id: r.id,
    title: r.title,
    slug: r.slug,
    contentKind: r.contentKind,
    categoryId: r.categoryId,
    categoryName: r.categoryId ? catName.get(r.categoryId) ?? null : null,
    tags: r.tags,
    language: r.language,
    summary: r.summary,
    estimatedMinutes: r.estimatedMinutes,
    ownerId: r.ownerId,
    ownerName: ownerName.get(r.ownerId) ?? null,
    authorIds: r.authorIds,
    status: r.status as LibraryModuleStatus,
    typeIcon: typeIconOf(r.contentKind, statsBy.get(r.id) ?? null),
    usageCount: r.usageCount,
    staleUsages: staleBy.get(r.id) ?? 0,
    currentVersion: r.currentVersionId ? versionById.get(r.currentVersionId) ?? null : null,
    archivedAt: r.archivedAt,
    archiveReason: r.archiveReason,
    createdAt: r.createdAt,
    updatedAt: r.updatedAt,
  }))
}

export interface LibraryModuleDetail extends LibraryModuleCard {
  authors: { id: string, fullName: string }[]
  /** Рабочая редакция тела (вкладка «Вміст», §5.2). */
  draft: { kind: string, body: ContentBlock[], mediaId: string | null, externalUrl: string | null, updatedAt: Date } | null
  /** Черновик отличается от последней версии — есть что публиковать. */
  hasUnpublishedChanges: boolean
  /** Может ли смотрящий править модуль (§7.12) — экран прячет кнопки, сервер всё равно проверяет. */
  canEdit: boolean
}

async function loadDetail(tx: TenantTx, actor: LibraryActor, id: string): Promise<LibraryModuleDetail | null> {
  const [m] = await tx.select().from(libraryModules).where(eq(libraryModules.id, id))
  if (!m) return null
  const [card] = await toCards(tx, [m])
  const authorRows = m.authorIds.length ? await tx.select({ id: users.id, fullName: users.fullName }).from(users).where(inArray(users.id, m.authorIds)) : []
  const nameOf = new Map(authorRows.map(a => [a.id, a.fullName]))
  const draft = await draftOf(tx, m)
  let hasUnpublishedChanges = true
  if (draft && m.currentVersionId) {
    const snap = await versionSnapshot(tx, m.currentVersionId)
    hasUnpublishedChanges = !snap || snap.snapshot.title !== draft.resource.title || snap.snapshot.kind !== draft.resource.kind
      || snap.snapshot.mediaId !== draft.resource.mediaId || snap.snapshot.externalUrl !== draft.resource.externalUrl
      || JSON.stringify(snap.snapshot.body) !== JSON.stringify(draft.resource.body)
  }
  return {
    ...card!,
    authors: m.authorIds.map(aid => ({ id: aid, fullName: nameOf.get(aid) ?? '' })),
    draft: draft
      ? { kind: draft.resource.kind, body: draft.resource.body as ContentBlock[], mediaId: draft.resource.mediaId, externalUrl: draft.resource.externalUrl, updatedAt: draft.resource.updatedAt }
      : null,
    hasUnpublishedChanges,
    canEdit: canEditModule(actor, m),
  }
}

export async function getModule(actor: LibraryActor, id: string): Promise<LibraryModuleDetail | null> {
  return withTenant(actor.tenantId, actor.actorId, tx => loadDetail(tx, actor, id))
}

// ── Список, поиск и палитра (§5.1, §5.4, §7.8) ───────────────────────────────────────────

/** Фильтры списка без строки поиска: одни и те же для страницы списка и для поиска. */
function filterConditions(q: LibraryListQuery): (SQL | undefined)[] {
  return [
    q.status === 'active' ? inArray(libraryModules.status, ['draft', 'published'])
    : q.status === 'all' ? undefined
      : eq(libraryModules.status, q.status),
    q.kind ? eq(libraryModules.contentKind, q.kind) : undefined,
    q.categoryId ? eq(libraryModules.categoryId, q.categoryId) : undefined,
    q.tag ? sql`${q.tag} = any(${libraryModules.tags})` : undefined,
    q.ownerId ? eq(libraryModules.ownerId, q.ownerId) : undefined,
    q.onlyUnused ? eq(libraryModules.usageCount, 0) : undefined,
    q.onlyStale ? sql`exists (select 1 from library_module_usages su where su.library_module_id = ${libraryModules.id} and su.detached_at is null and su.is_stale)` : undefined,
  ]
}

/**
 * Состав тела для иконки (§7.7) одним подзапросом: число блоков, из них чек-листов, есть ли
 * таблица (блок `table` или `<table` в HTML текстового блока — `shared/domain/library.ts#blockIsTable`).
 * Тела на сервер приложения не выгружаются.
 */
export function bodyStatsSql(body: SQL): SQL {
  return sql`select jsonb_array_length(coalesce(${body}, '[]'::jsonb))::int as blocks,
    (select count(*)::int from jsonb_array_elements(coalesce(${body}, '[]'::jsonb)) e where e->>'type' = 'checklist') as checklists,
    exists (select 1 from jsonb_array_elements(coalesce(${body}, '[]'::jsonb)) e
            where e->>'type' = 'table' or (e->>'type' = 'text' and e->>'html' ilike '%<table%')) as has_table`
}

/**
 * Поиск (§7.8, критерий 8). Полнотекст — всегда: `search_tsv` несёт название (A), описание и
 * метки (B) и тело последней опубликованной версии (C, миграция 0088), запрос — префиксный,
 * чтобы палитра находила недописанное слово; плюс `ilike` по названию. Запрос длиннее трёх слов
 * уходит в гибрид: к полнотексту добавляется векторный поиск по `embedding` (тело последней
 * версии, только векторы текущей модели — векторы разных моделей несравнимы), результаты
 * сливаются по RRF, лимит 50. Вектор запроса считается до транзакции: провайдер модели бывает
 * медленным, а транзакция его не ждёт.
 */
async function searchIds(tx: TenantTx, conds: (SQL | undefined)[], text: string, limit: number, queryVector: { vec: number[], model: string } | null): Promise<string[]> {
  const tsq = prefixTsQuery(text)
  const like = `%${text}%`
  const fullText = await tx.select({ id: libraryModules.id }).from(libraryModules)
    .where(and(...conds, or(tsq ? sql`${libraryModules.searchTsv} @@ to_tsquery('simple', ${tsq})` : undefined, ilike(libraryModules.title, like))))
    .orderBy(
      desc(sql`${libraryModules.title} ilike ${like}`),
      desc(tsq ? sql`ts_rank(${libraryModules.searchTsv}, to_tsquery('simple', ${tsq}))` : sql`0`),
      desc(libraryModules.updatedAt),
    )
    .limit(LIBRARY_LIMITS.searchLimit)
  let semantic: string[] = []
  if (queryVector) {
    const literal = `[${queryVector.vec.join(',')}]`
    const rows = await tx.select({ id: libraryModules.id, sim: sql<number>`1 - (${libraryModules.embedding} <=> ${literal}::vector)` }).from(libraryModules)
      .where(and(...conds, isNotNull(libraryModules.embedding), eq(libraryModules.embeddingModel, queryVector.model)))
      .orderBy(sql`${libraryModules.embedding} <=> ${literal}::vector`)
      .limit(LIBRARY_LIMITS.searchLimit)
    semantic = rows.filter(r => Number(r.sim) >= LIBRARY_LIMITS.vectorMinSimilarity).map(r => r.id)
  }
  return rrfMerge([fullText.map(r => r.id), semantic], limit)
}

export async function listModules(actor: LibraryActor, q: LibraryListQuery): Promise<{ items: LibraryModuleCard[], nextCursor: string | null, total: number }> {
  const text = q.q?.trim()
  let queryVector: { vec: number[], model: string } | null = null
  if (text && isHybridQuery(text)) {
    const provider = embeddingProvider(LIBRARY_LIMITS.embeddingDims)
    const [vec] = await provider.embed([text])
    if (vec) queryVector = { vec, model: provider.id }
  }
  return withTenant(actor.tenantId, actor.actorId, async (tx) => {
    const conds = filterConditions(q)
    if (text) {
      // Поиск — одна страница по релевантности (§7.8 «лимит 50»), курсора у него нет
      const ids = await searchIds(tx, conds, text, Math.min(q.limit, LIBRARY_LIMITS.searchLimit), queryVector)
      const rows = ids.length ? await tx.select().from(libraryModules).where(inArray(libraryModules.id, ids)) : []
      const byId = new Map(rows.map(r => [r.id, r]))
      const ordered = ids.map(id => byId.get(id)).filter((r): r is ModuleRow => !!r)
      return { items: await toCards(tx, ordered), nextCursor: null, total: ordered.length }
    }
    // Ключевой курсор (updated_at, id) — общая утилита: момент текстом из Postgres с микросекундами
    const rows = await tx.select({ row: libraryModules, cursorAt: keysetAt(libraryModules.updatedAt) }).from(libraryModules)
      .where(and(...conds, keysetAfter(KEYSETS.libraryModules, q.cursor, [libraryModules.updatedAt, libraryModules.id], 'desc')))
      .orderBy(desc(libraryModules.updatedAt), desc(libraryModules.id))
      .limit(q.limit + 1)
    const [{ total }] = await tx.select({ total: sql<number>`count(*)::int` }).from(libraryModules).where(and(...conds)) as [{ total: number }]
    const page = rows.slice(0, q.limit)
    const last = page[page.length - 1]
    return {
      items: await toCards(tx, page.map(r => r.row)),
      nextCursor: rows.length > q.limit && last ? encodeKeyset(KEYSETS.libraryModules, [last.cursorAt, last.row.id]) : null,
      total,
    }
  })
}

/**
 * «До 8 последних использованных модулей» палитры вставки (§5.4): сначала те, что вставлял
 * сам автор, затем — недавно вставленные коллегами (новому автору палитра не пуста). Только
 * опубликованные: архивного модуля в палитре нет (§7.6, критерий 4), у черновика нет версии.
 */
export async function recentModules(actor: LibraryActor): Promise<LibraryModuleCard[]> {
  return withTenant(actor.tenantId, actor.actorId, async (tx) => {
    const lastUsed = sql`max(${libraryModuleUsages.attachedAt})`
    const pick = (mine: boolean, except: string[]) => tx.select({ id: libraryModuleUsages.libraryModuleId }).from(libraryModuleUsages)
      .innerJoin(libraryModules, eq(libraryModules.id, libraryModuleUsages.libraryModuleId))
      .where(and(
        eq(libraryModules.status, 'published'),
        mine ? eq(libraryModuleUsages.attachedBy, actor.actorId) : undefined,
        except.length ? sql`${libraryModuleUsages.libraryModuleId} not in (${sql.join(except.map(id => sql`${id}::uuid`), sql`, `)})` : undefined,
      ))
      .groupBy(libraryModuleUsages.libraryModuleId)
      .orderBy(desc(lastUsed))
      .limit(LIBRARY_LIMITS.paletteRecent)
    const ids = (await pick(true, [])).map(r => r.id)
    if (ids.length < LIBRARY_LIMITS.paletteRecent) ids.push(...(await pick(false, ids)).map(r => r.id))
    const top = ids.slice(0, LIBRARY_LIMITS.paletteRecent)
    const rows = top.length ? await tx.select().from(libraryModules).where(inArray(libraryModules.id, top)) : []
    const byId = new Map(rows.map(r => [r.id, r]))
    return toCards(tx, top.map(id => byId.get(id)).filter((r): r is ModuleRow => !!r))
  })
}

// ── Создание и правка (§6.1) ─────────────────────────────────────────────────────────────

export type ModuleWriteResult
  = | { ok: true, module: LibraryModuleDetail }
    | { ok: false, code: 'not_found' | 'forbidden' | 'module_archived' | 'slug_taken' | 'owner_forbidden' | 'category_not_found' | 'too_many_authors' }

/** Уникальность `(tenant_id, slug)` — последняя линия против гонки двух одноимённых модулей. */
function slugRace(err: unknown): ModuleWriteResult {
  const e = err as { code?: string, constraint_name?: string }
  if (e.code === '23505' && e.constraint_name === 'library_modules_tenant_slug_uq') return { ok: false, code: 'slug_taken' }
  throw err
}

export async function createModule(actor: LibraryActor, input: LibraryModuleCreateInput): Promise<ModuleWriteResult> {
  return withTenant(actor.tenantId, actor.actorId, async (tx): Promise<ModuleWriteResult> => {
    if (!actor.publish) return { ok: false, code: 'forbidden' }
    const ownerId = input.ownerId ?? actor.actorId
    if (ownerId !== actor.actorId && !(await holdsScope(tx, ownerId, 'library.publish'))) return { ok: false, code: 'owner_forbidden' }
    if (input.categoryId && !(await categoryExists(tx, input.categoryId))) return { ok: false, code: 'category_not_found' }
    if (input.slug && await slugTaken(tx, input.slug)) return { ok: false, code: 'slug_taken' }
    const authorIds = authorIdsOf(ownerId, input.coauthorIds)
    if (authorIds.length > LIBRARY_LIMITS.authorsMax) return { ok: false, code: 'too_many_authors' }

    const id = await insertModuleTx(tx, actor, {
      title: input.title,
      slug: input.slug ?? await freeSlug(tx, input.title),
      contentKind: input.contentKind,
      categoryId: input.categoryId ?? null,
      tags: input.tags,
      summary: input.summary ?? null,
      estimatedMinutes: input.estimatedMinutes ?? null,
      language: input.language,
      ownerId,
      authorIds,
    }, { kind: input.contentKind, body: input.body as ContentBlock[], mediaId: input.mediaId, externalUrl: input.externalUrl })
    await recordAudit(tx, {
      tenantId: actor.tenantId, actorId: actor.actorId, action: 'library_module.create', entity: 'library_module', entityId: id,
      after: { title: input.title, contentKind: input.contentKind, ownerId },
    })
    return { ok: true, module: (await loadDetail(tx, actor, id))! }
  }).catch(slugRace)
}

/**
 * Правка карточки и черновика (§6.1, §7.12). Опубликованные версии не меняются — правка
 * копится в черновике до следующей публикации (Р-31.8: автосохранение версию не создаёт).
 * Архивный модуль не правится: «новые версии архивного модуля публиковать нельзя» (§7.6),
 * и черновик, который никогда не станет версией, только вводит в заблуждение.
 */
export async function updateModule(actor: LibraryActor, id: string, input: LibraryModuleUpdateInput): Promise<ModuleWriteResult> {
  return withTenant(actor.tenantId, actor.actorId, async (tx): Promise<ModuleWriteResult> => {
    const [m] = await tx.select().from(libraryModules).where(eq(libraryModules.id, id))
    if (!m) return { ok: false, code: 'not_found' }
    if (!canEditModule(actor, m)) return { ok: false, code: 'forbidden' }
    if (m.status === 'archived') return { ok: false, code: 'module_archived' }
    const ownerId = input.ownerId ?? m.ownerId
    if (ownerId !== m.ownerId && !(await holdsScope(tx, ownerId, 'library.publish'))) return { ok: false, code: 'owner_forbidden' }
    if (input.categoryId && !(await categoryExists(tx, input.categoryId))) return { ok: false, code: 'category_not_found' }
    if (input.slug && input.slug !== m.slug && await slugTaken(tx, input.slug, id)) return { ok: false, code: 'slug_taken' }
    const coauthors = input.coauthorIds ?? m.authorIds.filter(a => a !== ownerId)
    const authorIds = authorIdsOf(ownerId, coauthors)
    if (authorIds.length > LIBRARY_LIMITS.authorsMax) return { ok: false, code: 'too_many_authors' }

    const now = new Date()
    await tx.update(libraryModules).set({
      ...(input.title !== undefined ? { title: input.title } : {}),
      ...(input.slug !== undefined ? { slug: input.slug } : {}),
      ...(input.contentKind !== undefined ? { contentKind: input.contentKind } : {}),
      ...(input.categoryId !== undefined ? { categoryId: input.categoryId } : {}),
      ...(input.tags !== undefined ? { tags: input.tags } : {}),
      ...(input.summary !== undefined ? { summary: input.summary } : {}),
      ...(input.estimatedMinutes !== undefined ? { estimatedMinutes: input.estimatedMinutes } : {}),
      ...(input.language !== undefined ? { language: input.language } : {}),
      ownerId,
      authorIds,
      updatedAt: now,
    }).where(eq(libraryModules.id, id))

    const draft = await draftOf(tx, m)
    if (draft) {
      const body = input.body !== undefined ? sanitizeBody(input.body as ContentBlock[]) : undefined
      await tx.update(resources).set({
        ...(input.title !== undefined ? { title: input.title } : {}),
        ...(input.contentKind !== undefined ? { kind: input.contentKind } : {}),
        ...(input.summary !== undefined ? { summary: input.summary } : {}),
        ...(body !== undefined ? { body, plainText: blocksToText(body) } : {}),
        ...(input.mediaId !== undefined ? { mediaId: input.mediaId } : {}),
        ...(input.externalUrl !== undefined ? { externalUrl: input.externalUrl } : {}),
        ...(input.language !== undefined ? { language: input.language } : {}),
        ...(input.estimatedMinutes !== undefined ? { estimatedMinutes: input.estimatedMinutes } : {}),
        authorIds,
        updatedAt: now,
      }).where(eq(resources.id, draft.resource.id))
      if (input.title !== undefined) await tx.update(lessons).set({ title: input.title, updatedAt: now }).where(eq(lessons.id, draft.lesson.id))
    }

    await recordAudit(tx, {
      tenantId: actor.tenantId, actorId: actor.actorId, action: 'library_module.update', entity: 'library_module', entityId: id,
      before: { title: m.title, ownerId: m.ownerId, status: m.status }, after: { fields: Object.keys(input), ownerId },
    })
    return { ok: true, module: (await loadDetail(tx, actor, id))! }
  }).catch(slugRace)
}

// ── Версии (§3.3, §6.2, §7.2, §7.9) ──────────────────────────────────────────────────────

export type PublishVersionResult
  = | { ok: true, version: LibraryVersionRef & { diff: BlockDiff }, staleUsages: number, notified: number }
    | { ok: false, code: 'not_found' | 'forbidden' | 'module_archived' | 'empty_body' | 'media_not_ready' }
    | { ok: false, code: 'version_conflict', current: number | null }

/**
 * Публикация версии (§6.2). В одной транзакции: снимок тела, урок-снимок, строка версии,
 * `current_version_id`, `is_stale = true` всем активным местам на других версиях (§7.9).
 * Ни одно место не переключается само: публикация не имеет права менять содержание трека,
 * который человек проходит (Р-31.2); исключение — «Критичне виправлення» с `hotfix_auto`, его
 * после фиксации разносит фоновая `library.hotfix_propagate` (`libraryUsages.ts#propagateHotfix`).
 *
 * Параллельная публикация (§12): строка модуля блокируется `for update`, номер берётся
 * `max + 1`; если автор публиковал, глядя на устаревшую страницу (`expectedVersion`), —
 * `409 version_conflict` вместо молчаливой v5 поверх чужой v4.
 */
export async function publishVersion(actor: LibraryActor, id: string, input: LibraryPublishVersionInput): Promise<PublishVersionResult> {
  const result = await withTenant(actor.tenantId, actor.actorId, async (tx): Promise<PublishVersionResult> => {
    const [m] = await tx.select().from(libraryModules).where(eq(libraryModules.id, id)).for('update')
    if (!m) return { ok: false, code: 'not_found' }
    if (!canEditModule(actor, m)) return { ok: false, code: 'forbidden' }
    if (m.status === 'archived') return { ok: false, code: 'module_archived' }
    const draft = await draftOf(tx, m)
    if (!draft) throw new Error(`library_module ${id}: нет черновика`)
    const checks = await resourcePublishChecks(tx, draft.resource)
    if (!checks.find(c => c.code === 'kind_complete')?.ok) return { ok: false, code: 'empty_body' }
    if (!checks.find(c => c.code === 'media_ready')?.ok) return { ok: false, code: 'media_not_ready' }

    const [{ max }] = await tx.select({ max: sql<number>`coalesce(max(${libraryModuleVersions.version}), 0)::int` })
      .from(libraryModuleVersions).where(eq(libraryModuleVersions.libraryModuleId, id)) as [{ max: number }]
    const next = max + 1
    if (input.expectedVersion !== undefined && input.expectedVersion !== next) return { ok: false, code: 'version_conflict', current: max }

    const prev = m.currentVersionId ? await versionSnapshot(tx, m.currentVersionId) : null
    const body = draft.resource.body as ContentBlock[]
    const diff = diffBlocks((prev?.snapshot.body ?? []) as ContentBlock[], body)
    const now = new Date()

    const [{ rvMax }] = await tx.select({ rvMax: sql<number>`coalesce(max(${resourceVersions.version}), 0)::int` })
      .from(resourceVersions).where(eq(resourceVersions.resourceId, draft.resource.id)) as [{ rvMax: number }]
    const [snapshot] = await tx.insert(resourceVersions).values({
      tenantId: actor.tenantId,
      resourceId: draft.resource.id,
      version: rvMax + 1,
      title: m.title,
      kind: draft.resource.kind,
      body: draft.resource.body,
      plainText: draft.resource.plainText,
      mediaId: draft.resource.mediaId,
      externalUrl: draft.resource.externalUrl,
      changelog: input.changelog,
      publishedBy: actor.actorId,
    }).returning({ id: resourceVersions.id })
    // Статус тела остаётся `draft` — оно не ресурс базы знаний (libraryBody.ts); номер и
    // ссылка на снимок — чтобы «есть неопубликованные правки» считалось как у ресурса
    await tx.update(resources).set({ version: rvMax + 1, publishedVersionId: snapshot!.id, updatedAt: now }).where(eq(resources.id, draft.resource.id))

    const [snapLesson] = await tx.insert(lessons).values({
      tenantId: actor.tenantId,
      moduleId: null,
      libraryModuleId: id,
      title: m.title,
      sort: next,
      itemType: 'resource',
      itemId: draft.resource.id,
      resourceVersionId: snapshot!.id,
    }).returning({ id: lessons.id })

    const [version] = await tx.insert(libraryModuleVersions).values({
      tenantId: actor.tenantId,
      libraryModuleId: id,
      version: next,
      lessonId: snapLesson!.id,
      title: m.title,
      contentKind: draft.resource.kind,
      estimatedMinutes: m.estimatedMinutes,
      changelog: input.changelog,
      diff,
      isHotfix: input.isHotfix,
      mediaIds: mediaIdsOf(draft.resource.mediaId, body),
      publishedBy: actor.actorId,
    }).returning()

    await tx.update(libraryModules).set({
      currentVersionId: version!.id,
      status: m.status === 'draft' ? 'published' : m.status,
      updatedAt: now,
    }).where(eq(libraryModules.id, id))

    // §7.9: устаревают все активные места на других версиях — и только они
    const stale = await tx.update(libraryModuleUsages).set({ isStale: true, updatedAt: now })
      .where(and(eq(libraryModuleUsages.libraryModuleId, id), isNull(libraryModuleUsages.detachedAt), sql`${libraryModuleUsages.versionId} <> ${version!.id}`))
      .returning({ id: libraryModuleUsages.id })

    // §8 library_module_updated: авторам контейнеров, по одному на адресата (§12 — не 40 писем одному)
    let notified = 0
    if (input.notify && next > 1) {
      for (const [userId, containers] of await containerAuthors(tx, id)) {
        if (userId === actor.actorId) continue
        const sent = await enqueueNotification(tx, {
          tenantId: actor.tenantId, userId, code: 'library_module_updated',
          payload: { title: m.title, version: next, changelog: input.changelog, containers: containers.join(', ') },
          dedupKey: `library_module_updated:${id}:${next}:${userId}`,
          refType: 'library_module', refId: id,
        })
        if (sent) notified++
      }
    }

    await recordAudit(tx, {
      tenantId: actor.tenantId, actorId: actor.actorId, action: 'library_module.version_publish', entity: 'library_module', entityId: id,
      after: { version: next, versionId: version!.id, isHotfix: input.isHotfix, notify: input.notify, staleUsages: stale.length, diff },
    })
    return {
      ok: true,
      version: { id: version!.id, version: next, publishedAt: version!.publishedAt, changelog: version!.changelog, isHotfix: version!.isHotfix, diff },
      staleUsages: stale.length,
      notified,
    }
  }).catch((err: unknown) => {
    // Уникальность (tenant_id, library_module_id, version) — последняя линия против гонки (§12)
    if ((err as { code?: string }).code === '23505') return { ok: false as const, code: 'version_conflict' as const, current: null }
    throw err
  })
  if (result.ok) {
    await enqueueEmbeddingRefresh(actor.tenantId, id)
    // §7.4, §11: «Критичне виправлення» разносится по местам фоном — по событию публикации
    if (result.version.isHotfix) await enqueueHotfixPropagation(actor.tenantId, id, result.version.id)
  }
  return result
}

export interface LibraryVersionRow extends LibraryVersionRef {
  title: string
  contentKind: string
  status: string
  diff: BlockDiff
  publishedBy: { id: string, fullName: string } | null
  /** Сколько активных мест закрепляют эту версию (вкладка «Версії», §5.2). */
  activeUsages: number
}

export async function listVersions(actor: LibraryActor, id: string): Promise<LibraryVersionRow[] | null> {
  return withTenant(actor.tenantId, actor.actorId, async (tx) => {
    const [m] = await tx.select({ id: libraryModules.id }).from(libraryModules).where(eq(libraryModules.id, id))
    if (!m) return null
    const rows = await tx.select().from(libraryModuleVersions).where(eq(libraryModuleVersions.libraryModuleId, id)).orderBy(desc(libraryModuleVersions.version))
    const byIds = [...new Set(rows.map(r => r.publishedBy))]
    const people = byIds.length ? await tx.select({ id: users.id, fullName: users.fullName }).from(users).where(inArray(users.id, byIds)) : []
    const nameOf = new Map(people.map(p => [p.id, p.fullName]))
    const counts = await tx.select({ versionId: libraryModuleUsages.versionId, n: sql<number>`count(*)::int` }).from(libraryModuleUsages)
      .where(and(eq(libraryModuleUsages.libraryModuleId, id), isNull(libraryModuleUsages.detachedAt)))
      .groupBy(libraryModuleUsages.versionId)
    const countOf = new Map(counts.map(c => [c.versionId, c.n]))
    return rows.map(r => ({
      id: r.id,
      version: r.version,
      title: r.title,
      contentKind: r.contentKind,
      changelog: r.changelog,
      isHotfix: r.isHotfix,
      status: r.status,
      diff: r.diff as BlockDiff,
      publishedAt: r.publishedAt,
      publishedBy: { id: r.publishedBy, fullName: nameOf.get(r.publishedBy) ?? '' },
      activeUsages: countOf.get(r.id) ?? 0,
    }))
  })
}

/**
 * Одна версия с телом снимка — то, что показывает место использования, закреплённое на ней
 * (критерий 1: узел на v2 показывает тело v2, даже когда вышла v3).
 */
export async function getVersion(actor: LibraryActor, id: string, versionNo: number) {
  return withTenant(actor.tenantId, actor.actorId, async (tx) => {
    const [v] = await tx.select({ id: libraryModuleVersions.id }).from(libraryModuleVersions)
      .where(and(eq(libraryModuleVersions.libraryModuleId, id), eq(libraryModuleVersions.version, versionNo)))
    if (!v) return null
    const snap = await versionSnapshot(tx, v.id)
    if (!snap) return null
    return {
      id: snap.version.id,
      version: snap.version.version,
      title: snap.version.title,
      contentKind: snap.version.contentKind,
      changelog: snap.version.changelog,
      isHotfix: snap.version.isHotfix,
      status: snap.version.status,
      publishedAt: snap.version.publishedAt,
      diff: snap.version.diff as BlockDiff,
      lessonId: snap.lesson.id,
      body: snap.snapshot.body as ContentBlock[],
      mediaId: snap.snapshot.mediaId,
      externalUrl: snap.snapshot.externalUrl,
    }
  })
}

/** Версия для сравнения и диалога обновления (§5.2 «Порівняти з v3», §5.5). */
export interface VersionCompareRef extends LibraryVersionRef {
  title: string
}

export interface VersionCompare {
  moduleId: string
  moduleTitle: string
  from: VersionCompareRef
  to: VersionCompareRef
  /** Changelog каждой версии после `from` до `to` включительно — «що змінилось» между ними (§5.5). */
  changelogs: VersionCompareRef[]
  /** Поблочный diff по `block.id` (§3.3): добавленные бирюзой, удалённые кораллом, изменённые — «було / стало». */
  diff: BlockDiff
  before: ContentBlock[]
  after: ContentBlock[]
}

const compareRef = (v: typeof libraryModuleVersions.$inferSelect): VersionCompareRef => ({
  id: v.id, version: v.version, publishedAt: v.publishedAt, changelog: v.changelog, isHotfix: v.isHotfix, title: v.title,
})

/**
 * Сравнение двух версий модуля по номерам (внутри транзакции): тела неизменяемых снимков и
 * поблочный diff между ними — не цепочка сохранённых diff соседних версий, а прямое сравнение,
 * иначе блок, изменённый в v3 и возвращённый в v4, показался бы изменённым в v2→v4.
 */
export async function compareVersionsTx(tx: TenantTx, moduleId: string, fromNo: number, toNo: number): Promise<VersionCompare | null> {
  const [m] = await tx.select({ id: libraryModules.id, title: libraryModules.title }).from(libraryModules).where(eq(libraryModules.id, moduleId))
  if (!m) return null
  const versions = await tx.select().from(libraryModuleVersions).where(eq(libraryModuleVersions.libraryModuleId, moduleId))
  const from = versions.find(v => v.version === fromNo)
  const to = versions.find(v => v.version === toNo)
  if (!from || !to) return null
  const fromSnap = await versionSnapshot(tx, from.id)
  const toSnap = await versionSnapshot(tx, to.id)
  if (!fromSnap || !toSnap) return null
  const before = fromSnap.snapshot.body as ContentBlock[]
  const after = toSnap.snapshot.body as ContentBlock[]
  return {
    moduleId: m.id,
    moduleTitle: m.title,
    from: compareRef(from),
    to: compareRef(to),
    changelogs: skippedVersions(versions, Math.min(fromNo, toNo), Math.max(fromNo, toNo)).map(compareRef),
    diff: diffBlocks(before, after),
    before,
    after,
  }
}

export type CompareResult
  = | { ok: true, compare: VersionCompare }
    | { ok: false, code: 'not_found' | 'same_version' }

/** `GET /library/modules/:id/versions/:from/diff/:to` (§10): «Порівняти з v3» на вкладке «Версії». */
export async function compareVersions(actor: LibraryActor, moduleId: string, fromNo: number, toNo: number): Promise<CompareResult> {
  if (fromNo === toNo) return { ok: false, code: 'same_version' }
  return withTenant(actor.tenantId, actor.actorId, async (tx): Promise<CompareResult> => {
    const compare = await compareVersionsTx(tx, moduleId, fromNo, toNo)
    return compare ? { ok: true, compare } : { ok: false, code: 'not_found' }
  })
}

// ── Архив, восстановление, удаление (§4, §7.5, §7.6) ─────────────────────────────────────

export type ArchiveResult
  = | { ok: true, module: LibraryModuleDetail, notified: number }
    | { ok: false, code: 'not_found' | 'forbidden' | 'module_archived' }

/**
 * Архивирование (§7.6): модуль исчезает из палитры и списка по умолчанию, вставленные места
 * продолжают работать на закреплённых версиях — места **не трогаются вовсе**. Обучение не
 * должно ломаться от уборки в библиотеке. Причина обязательна: её увидят авторы треков.
 */
export async function archiveModule(actor: LibraryActor, id: string, reason: string): Promise<ArchiveResult> {
  return withTenant(actor.tenantId, actor.actorId, async (tx): Promise<ArchiveResult> => {
    const [m] = await tx.select().from(libraryModules).where(eq(libraryModules.id, id))
    if (!m) return { ok: false, code: 'not_found' }
    if (!canEditModule(actor, m)) return { ok: false, code: 'forbidden' }
    if (m.status === 'archived') return { ok: false, code: 'module_archived' }
    const now = new Date()
    await tx.update(libraryModules).set({ status: 'archived', archivedAt: now, archivedBy: actor.actorId, archiveReason: reason, updatedAt: now })
      .where(eq(libraryModules.id, id))
    let notified = 0
    for (const [userId] of await containerAuthors(tx, id)) {
      if (userId === actor.actorId) continue
      const sent = await enqueueNotification(tx, {
        tenantId: actor.tenantId, userId, code: 'library_module_archived',
        payload: { title: m.title, reason },
        dedupKey: `library_module_archived:${id}:${now.getTime()}:${userId}`,
        refType: 'library_module', refId: id,
      })
      if (sent) notified++
    }
    await recordAudit(tx, {
      tenantId: actor.tenantId, actorId: actor.actorId, action: 'library_module.archive', entity: 'library_module', entityId: id,
      before: { status: m.status }, after: { status: 'archived', reason, activeUsages: m.usageCount },
    })
    return { ok: true, module: (await loadDetail(tx, actor, id))!, notified }
  })
}

export type RestoreResult
  = | { ok: true, module: LibraryModuleDetail }
    | { ok: false, code: 'not_found' | 'forbidden' | 'not_archived' }

export async function restoreModule(actor: LibraryActor, id: string): Promise<RestoreResult> {
  return withTenant(actor.tenantId, actor.actorId, async (tx): Promise<RestoreResult> => {
    const [m] = await tx.select().from(libraryModules).where(eq(libraryModules.id, id))
    if (!m) return { ok: false, code: 'not_found' }
    if (!canEditModule(actor, m)) return { ok: false, code: 'forbidden' }
    if (m.status !== 'archived') return { ok: false, code: 'not_archived' }
    const status = restoredStatus(!!m.currentVersionId)
    await tx.update(libraryModules).set({ status, archivedAt: null, archivedBy: null, archiveReason: null, updatedAt: new Date() })
      .where(eq(libraryModules.id, id))
    await recordAudit(tx, {
      tenantId: actor.tenantId, actorId: actor.actorId, action: 'library_module.restore', entity: 'library_module', entityId: id,
      before: { status: m.status, reason: m.archiveReason }, after: { status },
    })
    return { ok: true, module: (await loadDetail(tx, actor, id))! }
  })
}

export interface UsageBrief {
  id: string
  holderType: string
  holderId: string
  holderTitle: string | null
  containerType: string
  containerId: string
  containerTitle: string
  version: number
}

export type DeleteModuleResult
  = | { ok: true }
    | { ok: false, code: 'not_found' | 'forbidden' }
    | { ok: false, code: 'in_use', reason: 'active_usages' | 'detached_usages' | 'versions', usages: UsageBrief[], total: number, detached: number, versions: number }

/**
 * Физическое удаление (§7.5, Р-31.3) — только носителю `library.manage` и только модуля,
 * который ничего не держит: активных мест 0, отключённых 0, версий не больше одной. Иначе —
 * `in_use` со списком активных мест (до 50 плюс общее число): «Видалити не можна — його можна
 * заархівувати» (§5.5). Порядок удаления задан явно — цикл «карточка ↔ версия ↔ урок-снимок»
 * не отдаётся на волю каскадов: версии, потом уроки модуля, потом карточка; тело-материал
 * помечается удалённым, как любой ресурс.
 */
export async function deleteModule(actor: LibraryActor, id: string): Promise<DeleteModuleResult> {
  return withTenant(actor.tenantId, actor.actorId, async (tx): Promise<DeleteModuleResult> => {
    const [m] = await tx.select().from(libraryModules).where(eq(libraryModules.id, id)).for('update')
    if (!m) return { ok: false, code: 'not_found' }
    if (!actor.manage) return { ok: false, code: 'forbidden' }
    const [counts] = await tx.select({
      active: sql<number>`count(*) filter (where ${libraryModuleUsages.detachedAt} is null)::int`,
      detached: sql<number>`count(*) filter (where ${libraryModuleUsages.detachedAt} is not null)::int`,
    }).from(libraryModuleUsages).where(eq(libraryModuleUsages.libraryModuleId, id))
    const [vc] = await tx.select({ n: sql<number>`count(*)::int` }).from(libraryModuleVersions).where(eq(libraryModuleVersions.libraryModuleId, id))
    const verdict = deletionVerdict({ active: counts?.active ?? 0, detached: counts?.detached ?? 0, versions: vc?.n ?? 0 })
    if (!verdict.allowed) {
      const usages = await tx.select({
        id: libraryModuleUsages.id, holderType: libraryModuleUsages.holderType, holderId: libraryModuleUsages.holderId,
        holderTitle: libraryModuleUsages.holderTitle, containerType: libraryModuleUsages.containerType,
        containerId: libraryModuleUsages.containerId, containerTitle: libraryModuleUsages.containerTitle, version: libraryModuleVersions.version,
      }).from(libraryModuleUsages)
        .innerJoin(libraryModuleVersions, eq(libraryModuleVersions.id, libraryModuleUsages.versionId))
        .where(and(eq(libraryModuleUsages.libraryModuleId, id), isNull(libraryModuleUsages.detachedAt)))
        .orderBy(libraryModuleUsages.containerTitle, libraryModuleUsages.attachedAt)
        .limit(LIBRARY_LIMITS.usagesInConflict)
      return { ok: false, code: 'in_use', reason: verdict.reason, usages, total: counts?.active ?? 0, detached: counts?.detached ?? 0, versions: vc?.n ?? 0 }
    }

    const bodies = await tx.select({ resourceId: lessons.itemId }).from(lessons).where(eq(lessons.libraryModuleId, id))
    await tx.update(libraryModules).set({ currentVersionId: null, draftLessonId: null }).where(eq(libraryModules.id, id))
    await tx.delete(libraryModuleVersions).where(eq(libraryModuleVersions.libraryModuleId, id))
    await tx.delete(lessons).where(eq(lessons.libraryModuleId, id))
    await tx.delete(libraryModules).where(eq(libraryModules.id, id))
    const resourceIds = [...new Set(bodies.map(b => b.resourceId))]
    if (resourceIds.length) await tx.update(resources).set({ deletedAt: new Date(), updatedAt: new Date() }).where(inArray(resources.id, resourceIds))
    await recordAudit(tx, {
      tenantId: actor.tenantId, actorId: actor.actorId, action: 'library_module.delete', entity: 'library_module', entityId: id,
      before: { title: m.title, slug: m.slug, status: m.status, ownerId: m.ownerId, versions: vc?.n ?? 0 },
    })
    return { ok: true }
  })
}

/** «Дублювати» (§5.2): новый черновик из текущего черновика, владелец — тот, кто копирует. */
export async function duplicateModule(actor: LibraryActor, id: string, title?: string): Promise<ModuleWriteResult> {
  return withTenant(actor.tenantId, actor.actorId, async (tx): Promise<ModuleWriteResult> => {
    if (!actor.publish) return { ok: false, code: 'forbidden' }
    const [m] = await tx.select().from(libraryModules).where(eq(libraryModules.id, id))
    if (!m) return { ok: false, code: 'not_found' }
    const draft = await draftOf(tx, m)
    const newTitle = (title ?? `${m.title} (копія)`).slice(0, LIBRARY_LIMITS.titleMax)
    const copyId = await insertModuleTx(tx, actor, {
      title: newTitle,
      slug: await freeSlug(tx, newTitle),
      contentKind: m.contentKind as ResourceKind,
      categoryId: m.categoryId,
      tags: m.tags,
      summary: m.summary,
      estimatedMinutes: m.estimatedMinutes,
      language: m.language,
      ownerId: actor.actorId,
      authorIds: [actor.actorId],
    }, {
      kind: (draft?.resource.kind ?? m.contentKind) as ResourceKind,
      body: (draft?.resource.body ?? []) as ContentBlock[],
      mediaId: draft?.resource.mediaId ?? null,
      externalUrl: draft?.resource.externalUrl ?? null,
    })
    await recordAudit(tx, {
      tenantId: actor.tenantId, actorId: actor.actorId, action: 'library_module.duplicate', entity: 'library_module', entityId: copyId,
      after: { from: id, title: newTitle },
    })
    return { ok: true, module: (await loadDetail(tx, actor, copyId))! }
  })
}

// ── Эмбеддинги (§7.8, §11 `library.embedding_refresh`) ───────────────────────────────────

/** После публикации — фоном: провайдер модели бывает медленным, транзакция публикации его не ждёт. */
async function enqueueEmbeddingRefresh(tenantId: string, moduleId: string): Promise<void> {
  const { enqueueForTenant } = await import('./tenantQueue')
  await enqueueForTenant('library.embedding_refresh', tenantId, { moduleId }, { singletonKey: `library.embed:${moduleId}` })
    .catch(err => console.error('[library.embedding_refresh] enqueue', moduleId, err))
}

/** `library.hotfix_propagate` (§11): места с `hotfix_auto` без людей в процессе переключаются на хотфикс. */
async function enqueueHotfixPropagation(tenantId: string, moduleId: string, versionId: string): Promise<void> {
  const { enqueueForTenant } = await import('./tenantQueue')
  await enqueueForTenant('library.hotfix_propagate', tenantId, { moduleId, versionId }, { singletonKey: `library.hotfix:${versionId}` })
    .catch(err => console.error('[library.hotfix_propagate] enqueue', versionId, err))
}

/**
 * Пересчёт эмбеддингов по телу **последней опубликованной версии** (§7.8), батч 20 (§11).
 * Берёт указанные модули или те, чей вектор пуст либо посчитан другой моделью
 * (`embedding_model` ≠ текущему провайдеру) — так смена провайдера сама находит устаревшие
 * строки. Без ключа работает заглушка (`embeddings.ts`). Возвращает число обновлённых модулей.
 */
export async function refreshLibraryEmbeddings(tenantId: string, moduleIds?: string[]): Promise<number> {
  const provider = embeddingProvider(LIBRARY_LIMITS.embeddingDims)
  return withTenant(tenantId, null, async (tx) => {
    const rows = await tx.select({
      id: libraryModules.id, title: libraryModules.title, summary: libraryModules.summary, tags: libraryModules.tags,
      plainText: resourceVersions.plainText,
    }).from(libraryModules)
      .innerJoin(libraryModuleVersions, eq(libraryModuleVersions.id, libraryModules.currentVersionId))
      .innerJoin(lessons, eq(lessons.id, libraryModuleVersions.lessonId))
      .innerJoin(resourceVersions, eq(resourceVersions.id, lessons.resourceVersionId))
      .where(and(
        isNotNull(libraryModules.currentVersionId),
        moduleIds?.length
          ? inArray(libraryModules.id, moduleIds)
          : or(isNull(libraryModules.embedding), sql`${libraryModules.embeddingModel} is distinct from ${provider.id}`),
      ))
      .limit(LIBRARY_LIMITS.embeddingBatch)
    if (!rows.length) return 0
    const vectors = await provider.embed(rows.map(r => embeddingText(r)))
    let updated = 0
    for (const [i, r] of rows.entries()) {
      const vec = vectors[i]
      if (!vec) continue
      await tx.update(libraryModules).set({ embedding: vec, embeddingModel: provider.id }).where(eq(libraryModules.id, r.id))
      updated++
    }
    return updated
  })
}

/** Для узлов траектории: заголовок держателя-узла — подпись блока или название контента. */
export async function trajectoryTitle(tx: TenantTx, id: string): Promise<{ id: string, title: string, status: string } | null> {
  const [t] = await tx.select({ id: trajectories.id, title: trajectories.title, status: trajectories.status }).from(trajectories).where(eq(trajectories.id, id))
  return t ?? null
}

/** Курс по id с признаком удаления — контейнер урока-держателя. */
export async function courseTitle(tx: TenantTx, id: string): Promise<{ id: string, title: string, deleted: boolean } | null> {
  const [c] = await tx.select({ id: courses.id, title: courses.title, deletedAt: courses.deletedAt }).from(courses).where(eq(courses.id, id))
  return c ? { id: c.id, title: c.title, deleted: !!c.deletedAt } : null
}
