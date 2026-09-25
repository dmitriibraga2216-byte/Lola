import { randomUUID } from 'node:crypto'
import { and, asc, desc, eq, isNull, sql } from 'drizzle-orm'
import { knowledgeArticles, knowledgeFeedback, knowledgeLinks, knowledgeRevisions, questions, resourceCategories, resources, searchQueries } from '../db/schema'
import { enqueueNotification } from './notifications'
import { resolveAudience } from './audience'
import type { Audience } from '../../shared/schemas/assignments'
import { withTenant } from '../utils/withTenant'
import type { TenantTx } from '../utils/withTenant'
import { recordAudit } from './audit'
import { sanitizeBody } from './sanitize'
import { slugify } from './courses'
import { canAccessResource } from './resources'
import { countView, noticeAudience } from './notices'
import { bookmarkKeys } from './hubExtra'
import { ratingAggregate } from './contentRatings'
import { recordActivity } from './activity'
import type { ContentBlock } from '../../shared/schemas/content'
import { embedTexts, type AiRef } from './ai/gateway'
import { KNOWLEDGE_EMBEDDING_PROMPT } from './ai/prompts'

interface Ctx { tenantId: string, actorId: string }

/** Плоский текст из блоков — для FTS и embedding. */
export function blocksToText(body: ContentBlock[]): string {
  return body.map((b) => {
    switch (b.type) {
      case 'heading': return b.text
      case 'text': return b.html.replace(/<[^>]+>/g, ' ')
      case 'callout': return `${b.title ?? ''} ${b.text}`
      case 'checklist': return b.items.join(' ')
      case 'quote': return b.text
      case 'image': return b.alt
      default: return ''
    }
  }).join(' ').replace(/\s+/g, ' ').trim().slice(0, 20_000)
}

/** Размерность векторов базы знаний — колонка `knowledge_articles.embedding vector(1536)`. */
const KNOWLEDGE_EMBEDDING_DIMS = 1536

/**
 * Embedding для семантического поиска (docs/03 §3.7) — через шлюз модели (`ai/gateway.ts`,
 * PR-27): профиль роли `embed`, строка `ai_calls` на каждый вызов. **Заглушка сюда не годится**
 * (`acceptStub: false`): у статьи нет колонки модели, и векторы заглушки смешались бы с векторами
 * настоящей модели в одном поиске без возможности их отличить (у библиотеки для этого есть
 * `embedding_model`). Пока профиль тенанта — заглушка, вызова нет и вектора нет: поиск работает
 * полнотекстово, ровно как до PR-27 без `EMBEDDINGS_URL`.
 */
async function embed(ctx: Ctx, text: string, ref: AiRef): Promise<number[] | null> {
  if (!text.trim()) return null
  const r = await embedTexts(ctx, { prompt: KNOWLEDGE_EMBEDDING_PROMPT, texts: [text.slice(0, 8000)], dims: KNOWLEDGE_EMBEDDING_DIMS, ref, acceptStub: false })
  return r.ok ? r.vectors[0] ?? null : null
}

export async function listArticles(ctx: Ctx, filter: { status?: string, categoryId?: string } = {}) {
  return withTenant(ctx.tenantId, ctx.actorId, async (tx) => {
    return tx.select({
      id: knowledgeArticles.id, title: knowledgeArticles.title, slug: knowledgeArticles.slug, summary: knowledgeArticles.summary,
      status: knowledgeArticles.status, tags: knowledgeArticles.tags, categoryId: knowledgeArticles.categoryId,
      version: knowledgeArticles.version, viewCount: knowledgeArticles.viewCount, updatedAt: knowledgeArticles.updatedAt,
      reviewAt: knowledgeArticles.reviewAt, reviewConfirmedAt: knowledgeArticles.reviewConfirmedAt, ownerId: knowledgeArticles.ownerId,
      helpfulCount: knowledgeArticles.helpfulCount, notHelpfulCount: knowledgeArticles.notHelpfulCount,
      needsReview: sql<boolean>`${knowledgeArticles.reviewAt} is not null and ${knowledgeArticles.reviewAt} < current_date - 30 and (${knowledgeArticles.reviewConfirmedAt} is null or ${knowledgeArticles.reviewConfirmedAt}::date < ${knowledgeArticles.reviewAt})`,
    }).from(knowledgeArticles)
      .where(and(
        isNull(knowledgeArticles.deletedAt),
        ...(filter.status ? [eq(knowledgeArticles.status, filter.status)] : []),
        ...(filter.categoryId ? [eq(knowledgeArticles.categoryId, filter.categoryId)] : []),
      ))
      .orderBy(desc(knowledgeArticles.updatedAt)).limit(200)
  })
}

export async function getArticle(ctx: Ctx, idOrSlug: string, opts: { countView?: boolean } = {}) {
  return withTenant(ctx.tenantId, ctx.actorId, async (tx) => {
    const isUuid = /^[0-9a-f-]{36}$/i.test(idOrSlug)
    const [a] = await tx.select().from(knowledgeArticles).where(and(
      isUuid ? eq(knowledgeArticles.id, idOrSlug) : eq(knowledgeArticles.slug, idOrSlug),
      isNull(knowledgeArticles.deletedAt),
    ))
    if (!a) return null
    // Просмотр считается раз на человека в день (Spec 21) — и столько же раз статья попадает в
    // ленту активности как `knowledge_read` (docs/v2/38 §7.9): перечитывание в тот же день не событие
    if (opts.countView && await countView(tx, ctx, 'article', a.id, a.title)) {
      await recordActivity(tx, ctx.tenantId, { userId: ctx.actorId, kind: 'knowledge_read', ref: { entity: 'knowledge_articles', id: a.id } })
    }
    const links = await tx.select().from(knowledgeLinks).where(eq(knowledgeLinks.articleId, a.id))
    const [my] = await tx.select({ helpful: knowledgeFeedback.helpful }).from(knowledgeFeedback).where(and(eq(knowledgeFeedback.articleId, a.id), eq(knowledgeFeedback.userId, ctx.actorId)))
    const related = a.relatedArticles.length ? await tx.select({ id: knowledgeArticles.id, title: knowledgeArticles.title, slug: knowledgeArticles.slug }).from(knowledgeArticles).where(and(sql`${knowledgeArticles.id} in ${a.relatedArticles}`, eq(knowledgeArticles.status, 'published'), isNull(knowledgeArticles.deletedAt))) : []
    const courses = a.relatedCourses.length ? await tx.execute(sql`select id, title from courses where id in ${a.relatedCourses} and status = 'published' and deleted_at is null`) as unknown as { id: string, title: string }[] : []
    const [owner] = a.ownerId ? await tx.execute(sql`select full_name from users where id = ${a.ownerId}::uuid`) as unknown as { full_name: string }[] : []
    const needsReview = !!a.reviewAt && new Date(a.reviewAt) < new Date(Date.now() - 30 * 86_400_000) && (!a.reviewConfirmedAt || a.reviewConfirmedAt < new Date(a.reviewAt))
    const rating = await ratingAggregate(ctx, 'knowledge_article', a.id) // «Оцінок: N · середня X» (докс/33 D-042)
    const { embedding: _e, searchTsv: _t, ...safe } = a
    return { ...safe, links, myFeedback: my?.helpful ?? null, related, relatedCourseItems: courses, ownerName: owner?.full_name ?? null, needsReview, rating }
  })
}

export async function createArticle(ctx: Ctx, input: { title: string, summary?: string, body: ContentBlock[], categoryId?: string, tags?: string[], visibility?: unknown, ownerId?: string, reviewAt?: string | null, relatedCourses?: string[], relatedArticles?: string[], attachments?: { mediaId: string, name: string }[] }) {
  const body = sanitizeBody(input.body)
  const plainText = blocksToText(body)
  const id = randomUUID()
  const vec = await embed(ctx, `${input.title}\n${plainText}`, { kind: 'knowledge_article', id })
  return withTenant(ctx.tenantId, ctx.actorId, async (tx) => {
    const [a] = await tx.insert(knowledgeArticles).values({
      id,
      tenantId: ctx.tenantId,
      title: input.title,
      slug: `${slugify(input.title)}-${randomUUID().slice(0, 4)}`,
      summary: input.summary ?? null,
      body,
      plainText,
      categoryId: input.categoryId ?? null,
      tags: input.tags ?? [],
      visibility: input.visibility ?? { scope: 'tenant' },
      embedding: vec,
      updatedBy: ctx.actorId,
      ownerId: input.ownerId ?? ctx.actorId, // docs/21 §6.1: «Хтось має відповідати за актуальність»
      reviewAt: input.reviewAt ?? null, relatedCourses: input.relatedCourses ?? [], relatedArticles: input.relatedArticles ?? [], attachments: input.attachments ?? [],
    }).returning({ id: knowledgeArticles.id, slug: knowledgeArticles.slug })
    await tx.insert(knowledgeRevisions).values({ tenantId: ctx.tenantId, articleId: a!.id, version: 1, title: input.title, body, authorId: ctx.actorId })
    await recordAudit(tx, { tenantId: ctx.tenantId, actorId: ctx.actorId, action: 'knowledge.create', entity: 'knowledge_article', entityId: a!.id, after: { title: input.title } })
    return a!
  })
}

export async function updateArticle(ctx: Ctx, id: string, input: { title?: string, summary?: string, body?: ContentBlock[], categoryId?: string | null, tags?: string[], status?: string, comment?: string, visibility?: unknown, ownerId?: string, reviewAt?: string | null, relatedCourses?: string[], relatedArticles?: string[], attachments?: { mediaId: string, name: string }[] }) {
  const body = input.body ? sanitizeBody(input.body) : undefined
  const plainText = body ? blocksToText(body) : undefined
  return withTenant(ctx.tenantId, ctx.actorId, async (tx) => {
    const [before] = await tx.select().from(knowledgeArticles).where(and(eq(knowledgeArticles.id, id), isNull(knowledgeArticles.deletedAt)))
    if (!before) return null
    const contentChanged = body !== undefined || (input.title !== undefined && input.title !== before.title)
    const version = contentChanged ? before.version + 1 : before.version
    const vec = contentChanged ? await embed(ctx, `${input.title ?? before.title}\n${plainText ?? before.plainText}`, { kind: 'knowledge_article', id }) : undefined

    const [after] = await tx.update(knowledgeArticles).set({
      ...(input.title !== undefined ? { title: input.title } : {}),
      ...(input.summary !== undefined ? { summary: input.summary } : {}),
      ...(body !== undefined ? { body, plainText } : {}),
      ...(input.categoryId !== undefined ? { categoryId: input.categoryId } : {}),
      ...(input.tags !== undefined ? { tags: input.tags } : {}),
      ...(input.status !== undefined ? { status: input.status } : {}),
      ...(input.visibility !== undefined ? { visibility: input.visibility } : {}),
      ...(input.ownerId !== undefined ? { ownerId: input.ownerId } : {}),
      ...(input.reviewAt !== undefined ? { reviewAt: input.reviewAt } : {}),
      ...(input.relatedCourses !== undefined ? { relatedCourses: input.relatedCourses } : {}),
      ...(input.relatedArticles !== undefined ? { relatedArticles: input.relatedArticles } : {}),
      ...(input.attachments !== undefined ? { attachments: input.attachments } : {}),
      ...(vec !== undefined ? { embedding: vec } : {}),
      version,
      updatedBy: ctx.actorId,
      updatedAt: new Date(),
    }).where(eq(knowledgeArticles.id, id)).returning({ id: knowledgeArticles.id, version: knowledgeArticles.version, status: knowledgeArticles.status })

    if (contentChanged) {
      await tx.insert(knowledgeRevisions).values({
        tenantId: ctx.tenantId, articleId: id, version, title: input.title ?? before.title, body: body ?? before.body, authorId: ctx.actorId, comment: input.comment ?? null,
      })
    }
    await recordAudit(tx, { tenantId: ctx.tenantId, actorId: ctx.actorId, action: 'knowledge.update', entity: 'knowledge_article', entityId: id, before: { version: before.version }, after: { version } })
    return after!
  })
}

export async function linkArticle(ctx: Ctx, articleId: string, targetType: 'lesson' | 'position', targetId: string) {
  return withTenant(ctx.tenantId, ctx.actorId, async (tx) => {
    const [l] = await tx.insert(knowledgeLinks).values({ tenantId: ctx.tenantId, articleId, targetType, targetId }).onConflictDoNothing().returning()
    return l ?? null
  })
}

export async function revisions(ctx: Ctx, articleId: string) {
  return withTenant(ctx.tenantId, ctx.actorId, async (tx) => {
    return tx.select({ id: knowledgeRevisions.id, version: knowledgeRevisions.version, title: knowledgeRevisions.title, authorId: knowledgeRevisions.authorId, comment: knowledgeRevisions.comment, createdAt: knowledgeRevisions.createdAt })
      .from(knowledgeRevisions).where(eq(knowledgeRevisions.articleId, articleId)).orderBy(desc(knowledgeRevisions.version))
  })
}

/**
 * Квази-основа для украинского без стеммера: конфиг 'simple' не знает морфологии,
 * а «риба» должна находить «риби»/«рибу». Отрезаем 1–2 буквы окончания у слов ≥5 букв,
 * дальше префиксный матч :*.
 */
export function stem(word: string): string {
  const w = word.toLowerCase()
  if (w.length >= 7) return w.slice(0, -2)
  if (w.length >= 4) return w.slice(0, -1)
  return w
}

export interface SearchHit { kind: 'article' | 'lesson' | 'question' | 'news' | 'notice', id: string, title: string, snippet: string, score: number, slug?: string, bookmarked?: boolean, views?: number }

/** Статья доступна человеку по аудитории (docs/21 §7.1): visibility.scope=tenant — всем; иначе конструктор аудитории. */
async function visibleArticleIds(tx: TenantTx, actorId: string, ids: string[]): Promise<Set<string>> {
  if (!ids.length) return new Set()
  const rows = await tx.select({ id: knowledgeArticles.id, visibility: knowledgeArticles.visibility }).from(knowledgeArticles).where(sql`${knowledgeArticles.id} in ${ids}`)
  const out = new Set<string>()
  for (const r of rows) {
    const v = r.visibility as { scope?: string, audience?: Audience }
    if (!v || v.scope === 'tenant' || !v.audience) { out.add(r.id); continue }
    const set = await resolveAudience(tx, v.audience)
    if (set.has(actorId)) out.add(r.id)
  }
  return out
}

/**
 * Поиск (docs/21 §5.2, §7.1, §14.1; docs/04 §4.13 `?in=`): точное совпадение по заголовку ×3, полнотекст ×2,
 * семантика ×1; источники — `resources` (статья базы знаний, урок-ресурс, вопрос теста), `news`, `notices`
 * (объявления, назначенные человеку); ресурсы — только доступные по группам доступа, статьи — по аудитории;
 * недоступное не показывается даже заголовком; каждый запрос — в журнал (пустые — отчёт).
 */
export async function search(ctx: Ctx, q: string, limit = 20, source: 'all' | 'resources' | 'news' | 'notices' = 'all'): Promise<SearchHit[]> {
  const words = q.trim().split(/\s+/).filter(w => w.length >= 2).slice(0, 8)
  if (words.length === 0) return []
  const tsq = words.map(w => `${stem(w.replace(/[':&|!()]/g, ''))}:*`).join(' & ')
  const vec = source === 'all' || source === 'resources' ? await embed(ctx, q, { kind: 'search_query', id: null }) : null
  const like = `%${q.trim()}%`
  const want = (k: 'resources' | 'news' | 'notices') => source === 'all' || source === k
  // Новости и объявления без FTS-индекса: каждое слово — ilike по заголовку или тексту, все слова обязательны
  const wordsLike = (title: ReturnType<typeof sql>, body: ReturnType<typeof sql>) => sql.join(words.map(w => sql`(${title} ilike ${`%${w}%`} or ${body} ilike ${`%${w}%`})`), sql` and `)

  return withTenant(ctx.tenantId, ctx.actorId, async (tx) => {
    const none: never[] = []
    const articles = !want('resources') ? none : await tx.execute(sql`
      select id, title, slug, ts_headline('simple', plain_text, to_tsquery('simple', ${tsq}), 'MaxWords=25, MinWords=10') as snippet,
             ts_rank(search_tsv, to_tsquery('simple', ${tsq})) as score, (title ilike ${like}) as title_hit
      from knowledge_articles
      where status = 'published' and deleted_at is null and (search_tsv @@ to_tsquery('simple', ${tsq}) or title ilike ${like})
      order by title_hit desc, score desc limit ${limit}
    `) as unknown as { id: string, title: string, slug: string, snippet: string, score: number, title_hit: boolean }[]

    const lessons = !want('resources') ? none : await tx.execute(sql`
      select r.id, r.title, r.views_count, ts_headline('simple', r.plain_text, to_tsquery('simple', ${tsq}), 'MaxWords=25, MinWords=10') as snippet,
             ts_rank(r.search_tsv, to_tsquery('simple', ${tsq})) as score, (r.title ilike ${like}) as title_hit
      from resources r
      where r.status = 'published' and r.deleted_at is null and (r.search_tsv @@ to_tsquery('simple', ${tsq}) or r.title ilike ${like})
      order by title_hit desc, score desc limit ${limit}
    `) as unknown as { id: string, title: string, views_count: number, snippet: string, score: number, title_hit: boolean }[]

    // Вопросы тестов: текст из блоков stem (без FTS-индекса — ilike по извлечённому тексту)
    const qrows = !want('resources') ? none : await tx.execute(sql`
      select q.id, left(regexp_replace(coalesce(string_agg(b->>'html', ' ' order by 1), ''), '<[^>]+>', ' ', 'g'), 300) as text
      from ${questions} q cross join lateral jsonb_array_elements(q.stem) b
      where q.status = 'active' group by q.id
      having string_agg(b->>'html', ' ') ilike ${like} limit ${limit}
    `) as unknown as { id: string, text: string }[]

    let semantic: { id: string, title: string, slug: string, snippet: string, score: number }[] = []
    if (vec) {
      semantic = await tx.execute(sql`
        select id, title, slug, left(plain_text, 160) as snippet, 1 - (embedding <=> ${`[${vec.join(',')}]`}::vector) as score
        from knowledge_articles
        where status = 'published' and deleted_at is null and embedding is not null
        order by embedding <=> ${`[${vec.join(',')}]`}::vector limit ${limit}
      `) as unknown as typeof semantic
      semantic = semantic.filter(s => Number(s.score) > 0.75)
    }

    // Новости (Spec 21): заголовок ×3, анонс/текст — ilike (FTS-индекса у новостей нет); только опубликованные и по аудитории
    const newsRows = !want('news') ? none : await tx.execute(sql`
      select n.id, n.title, n.views_count, n.audience, left(coalesce(n.lead, regexp_replace(n.body::text, '<[^>]+>', ' ', 'g')), 160) as snippet, (n.title ilike ${like}) as title_hit
      from news n where n.status = 'published' and n.deleted_at is null and (${wordsLike(sql`n.title`, sql`coalesce(n.lead, '') || ' ' || n.body::text`)})
      order by title_hit desc, n.published_at desc limit ${limit}
    `) as unknown as { id: string, title: string, views_count: number, audience: Audience | null, snippet: string, title_hit: boolean }[]

    // Объявления (Spec 21): только назначенные человеку — чужое не показывается даже заголовком
    const noticeRows = !want('notices') ? none : await tx.execute(sql`
      select o.id, o.title, o.views_count, left(regexp_replace(o.body::text, '<[^>]+>', ' ', 'g'), 160) as snippet, (o.title ilike ${like}) as title_hit
      from notices o where o.status = 'published' and o.deleted_at is null and (${wordsLike(sql`o.title`, sql`o.body::text`)})
      order by title_hit desc, o.published_at desc limit ${limit}
    `) as unknown as { id: string, title: string, views_count: number, snippet: string, title_hit: boolean }[]

    const merged = new Map<string, SearchHit>()
    for (const a of articles) merged.set(`article:${a.id}`, { kind: 'article', id: a.id, slug: a.slug, title: a.title, snippet: a.snippet, score: (a.title_hit ? 3 : 0) + Number(a.score) * 2 })
    for (const l of lessons) {
      if (!(await canAccessResource(tx, ctx.actorId, l.id))) continue // группы доступа (docs/21 §14.1)
      merged.set(`lesson:${l.id}`, { kind: 'lesson', id: l.id, title: l.title, snippet: l.snippet, score: (l.title_hit ? 3 : 0) + Number(l.score) * 2, views: l.views_count })
    }
    for (const n of newsRows) {
      if (n.audience && !(await resolveAudience(tx, n.audience)).has(ctx.actorId)) continue
      merged.set(`news:${n.id}`, { kind: 'news', id: n.id, title: n.title, snippet: n.snippet, score: n.title_hit ? 3 : 1, views: n.views_count })
    }
    for (const o of noticeRows) {
      if (!(await noticeAudience(tx, o.id)).userIds.has(ctx.actorId)) continue
      merged.set(`notice:${o.id}`, { kind: 'notice', id: o.id, title: o.title, snippet: o.snippet, score: o.title_hit ? 3 : 1, views: o.views_count })
    }
    for (const qq of qrows) merged.set(`question:${qq.id}`, { kind: 'question', id: qq.id, title: qq.text.slice(0, 120), snippet: qq.text, score: 1 })
    for (const s of semantic) {
      const key = `article:${s.id}`
      const existing = merged.get(key)
      if (existing) existing.score += Number(s.score)
      else merged.set(key, { kind: 'article', id: s.id, slug: s.slug, title: s.title, snippet: s.snippet, score: Number(s.score) })
    }
    // Недоступные по аудитории статьи — вон, даже заголовком (docs/21 §12)
    const visible = await visibleArticleIds(tx, ctx.actorId, [...merged.values()].filter(h => h.kind === 'article').map(h => h.id))
    const marks = await bookmarkKeys(tx, ctx.actorId)
    const keyOf = (h: SearchHit) => `${h.kind === 'lesson' ? 'resource' : h.kind}:${h.id}`
    const hits = [...merged.values()].filter(h => h.kind !== 'article' || visible.has(h.id)).sort((a, b) => b.score - a.score).slice(0, limit)
      .map(h => ({ ...h, bookmarked: marks.has(keyOf(h)) }))
    await tx.insert(searchQueries).values({ tenantId: ctx.tenantId, userId: ctx.actorId, query: q.trim().slice(0, 200), results: hits.length })
    return hits
  })
}

/**
 * Дерево категорій бази знань (docs/33 D-041, docs/28 Spec 21 відк. (1); мокап Knowledge —
 * «КАТЕГОРІЇ» зліва: Інформація про компанію, Торгові точки, Кухня…). Категорії — вітрина над
 * тим самим `resource_categories`, що й `/admin/knowledge` (без лічильників — вони вимагали б
 * тих самих груп доступу, що й перегляд ресурсу, а порахувати їх дешево наперед не можна).
 */
export async function categoriesTree(ctx: Ctx): Promise<{ id: string, name: string, parentId: string | null }[]> {
  return withTenant(ctx.tenantId, ctx.actorId, async (tx) =>
    tx.select({ id: resourceCategories.id, name: resourceCategories.name, parentId: resourceCategories.parentId })
      .from(resourceCategories).orderBy(asc(resourceCategories.sortOrder), asc(resourceCategories.name)))
}

/** Ресурси однієї категорії (клік по дереву) — ті самі правила доступу, що й у `search()`, без пошукового запиту. */
export async function resourcesByCategory(ctx: Ctx, categoryId: string, limit = 50): Promise<SearchHit[]> {
  return withTenant(ctx.tenantId, ctx.actorId, async (tx) => {
    const rows = await tx.execute(sql`
      select r.id, r.title, r.views_count, left(coalesce(r.plain_text, ''), 160) as snippet
      from resources r
      where r.status = 'published' and r.deleted_at is null and ${categoryId}::uuid = any(r.category_ids)
      order by r.title limit ${limit}
    `) as unknown as { id: string, title: string, views_count: number, snippet: string }[]
    const marks = await bookmarkKeys(tx, ctx.actorId)
    const out: SearchHit[] = []
    for (const l of rows) {
      if (!(await canAccessResource(tx, ctx.actorId, l.id))) continue
      out.push({ kind: 'lesson', id: l.id, title: l.title, snippet: l.snippet, score: 0, views: l.views_count, bookmarked: marks.has(`resource:${l.id}`) })
    }
    return out
  })
}

// ── Обратная связь и актуальность (docs/21 §5.2, §7.2) ────────────────

export async function feedback(ctx: Ctx, articleId: string, helpful: boolean, comment?: string) {
  return withTenant(ctx.tenantId, ctx.actorId, async (tx) => {
    const [a] = await tx.select({ id: knowledgeArticles.id }).from(knowledgeArticles).where(and(eq(knowledgeArticles.id, articleId), isNull(knowledgeArticles.deletedAt)))
    if (!a) return null
    await tx.insert(knowledgeFeedback).values({ tenantId: ctx.tenantId, articleId, userId: ctx.actorId, helpful, comment: comment ?? null })
      .onConflictDoUpdate({ target: [knowledgeFeedback.tenantId, knowledgeFeedback.articleId, knowledgeFeedback.userId], set: { helpful, comment: comment ?? null, updatedAt: new Date() } })
    const [c] = await tx.execute(sql`select count(*) filter (where helpful)::int as h, count(*) filter (where not helpful)::int as n from knowledge_feedback where article_id = ${articleId}::uuid`) as unknown as { h: number, n: number }[]
    await tx.update(knowledgeArticles).set({ helpfulCount: c!.h, notHelpfulCount: c!.n }).where(eq(knowledgeArticles.id, articleId))
    return { helpful: c!.h, notHelpful: c!.n }
  })
}

/** «Підтвердити актуальність»: владелец/автор перечитал — следующий срок через 180 дней, если не задан иначе. */
export async function confirmActual(ctx: Ctx, articleId: string, nextReviewAt?: string) {
  return withTenant(ctx.tenantId, ctx.actorId, async (tx) => {
    const next = nextReviewAt ?? new Date(Date.now() + 180 * 86_400_000).toISOString().slice(0, 10)
    const [a] = await tx.update(knowledgeArticles).set({ reviewConfirmedAt: new Date(), reviewAt: next, updatedAt: new Date() }).where(and(eq(knowledgeArticles.id, articleId), isNull(knowledgeArticles.deletedAt))).returning({ id: knowledgeArticles.id, reviewAt: knowledgeArticles.reviewAt })
    if (a) await recordAudit(tx, { tenantId: ctx.tenantId, actorId: ctx.actorId, action: 'knowledge.confirm_actual', entity: 'knowledge_article', entityId: articleId, after: { reviewAt: next } })
    return a ?? null
  })
}

/** Ежедневно (docs/21 §11 knowledge.review_scan): наступил review_at — владельцу задача; через 30 дней без подтверждения — плашка (считается на чтении). */
export async function reviewScan(tenantId: string): Promise<number> {
  return withTenant(tenantId, null, async (tx) => {
    const rows = await tx.select({ id: knowledgeArticles.id, title: knowledgeArticles.title, ownerId: knowledgeArticles.ownerId, reviewAt: knowledgeArticles.reviewAt })
      .from(knowledgeArticles)
      .where(and(eq(knowledgeArticles.status, 'published'), isNull(knowledgeArticles.deletedAt), sql`${knowledgeArticles.reviewAt} <= current_date`, sql`(${knowledgeArticles.reviewConfirmedAt} is null or ${knowledgeArticles.reviewConfirmedAt}::date < ${knowledgeArticles.reviewAt})`))
    let n = 0
    for (const a of rows) {
      if (!a.ownerId) continue
      if (await enqueueNotification(tx, { tenantId, userId: a.ownerId, code: 'knowledge_review_due', payload: { title: a.title, articleId: a.id }, dedupKey: `kb_review:${a.id}:${a.reviewAt}` })) n++
    }
    return n
  })
}

/** Автор уволился (docs/21 §12): владелец → тот, кто архивирует; статья помечается к проверке. */
export async function reassignOwner(tx: TenantTx, tenantId: string, fromUserId: string, toUserId: string): Promise<number> {
  const rows = await tx.update(knowledgeArticles).set({ ownerId: toUserId, reviewAt: sql`current_date - 31`, reviewConfirmedAt: null, updatedAt: new Date() })
    .where(and(eq(knowledgeArticles.ownerId, fromUserId), isNull(knowledgeArticles.deletedAt))).returning({ id: knowledgeArticles.id })
  void tenantId
  return rows.length
}

/** Отчёт «База знань» (docs/21 §9): самые читаемые, с плохой обратной связью, просроченные, запросы без результата. */
export async function knowledgeReport(ctx: Ctx) {
  return withTenant(ctx.tenantId, ctx.actorId, async (tx) => {
    const top = await tx.execute(sql`select id, title, slug, view_count, helpful_count, not_helpful_count from knowledge_articles where deleted_at is null and status = 'published' order by view_count desc limit 20`) as unknown as Record<string, unknown>[]
    const poor = await tx.execute(sql`select id, title, slug, helpful_count, not_helpful_count from knowledge_articles where deleted_at is null and not_helpful_count > 0 and not_helpful_count >= helpful_count order by not_helpful_count desc limit 20`) as unknown as Record<string, unknown>[]
    const overdue = await tx.execute(sql`select a.id, a.title, a.slug, a.review_at, u.full_name as owner from knowledge_articles a left join users u on u.id = a.owner_id where a.deleted_at is null and a.review_at < current_date and (a.review_confirmed_at is null or a.review_confirmed_at::date < a.review_at) order by a.review_at limit 50`) as unknown as Record<string, unknown>[]
    const empty = await tx.execute(sql`select lower(query) as query, count(*)::int as times, max(created_at) as last_at from search_queries where results = 0 and created_at > now() - interval '90 days' group by 1 order by 2 desc, 3 desc limit 50`) as unknown as Record<string, unknown>[]
    return { top, poor, overdue, emptyQueries: empty }
  })
}

/** Пересчёт plain_text у существующих материалов (одноразово после миграции). */
export async function reindexResources(tenantId: string): Promise<number> {
  return withTenant(tenantId, null, async (tx) => {
    const rows = await tx.select({ id: resources.id, body: resources.body }).from(resources)
    for (const r of rows) {
      await tx.update(resources).set({ plainText: blocksToText(r.body as ContentBlock[]) }).where(eq(resources.id, r.id))
    }
    return rows.length
  })
}
