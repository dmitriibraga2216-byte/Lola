import { randomUUID } from 'node:crypto'
import { and, desc, eq, isNull, sql } from 'drizzle-orm'
import { knowledgeArticles, knowledgeLinks, knowledgeRevisions, resources } from '../db/schema'
import { withTenant } from '../utils/withTenant'
import { recordAudit } from './audit'
import { sanitizeBody } from './sanitize'
import { slugify } from './courses'
import type { ContentBlock } from '../../shared/schemas/content'

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

/**
 * Embedding для семантического поиска (docs/03 §3.7). Провайдер — через
 * EMBEDDINGS_URL (OpenAI-совместимый /v1/embeddings); без него — null,
 * поиск работает только полнотекстово. Ключ не логируется.
 */
export async function embed(text: string): Promise<number[] | null> {
  const url = process.env.EMBEDDINGS_URL
  const key = process.env.EMBEDDINGS_API_KEY
  if (!url || !text.trim()) return null
  try {
    const res = await fetch(url, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json', ...(key ? { Authorization: `Bearer ${key}` } : {}) },
      body: JSON.stringify({ model: process.env.EMBEDDINGS_MODEL || 'text-embedding-3-small', input: text.slice(0, 8000) }),
      signal: AbortSignal.timeout(15_000),
    })
    const json = await res.json() as { data?: { embedding: number[] }[] }
    const v = json.data?.[0]?.embedding
    return v && v.length === 1536 ? v : null
  }
  catch {
    return null
  }
}

export async function listArticles(ctx: Ctx, filter: { status?: string, categoryId?: string } = {}) {
  return withTenant(ctx.tenantId, ctx.actorId, async (tx) => {
    return tx.select({
      id: knowledgeArticles.id, title: knowledgeArticles.title, slug: knowledgeArticles.slug, summary: knowledgeArticles.summary,
      status: knowledgeArticles.status, tags: knowledgeArticles.tags, categoryId: knowledgeArticles.categoryId,
      version: knowledgeArticles.version, viewCount: knowledgeArticles.viewCount, updatedAt: knowledgeArticles.updatedAt,
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
    if (opts.countView) await tx.update(knowledgeArticles).set({ viewCount: a.viewCount + 1 }).where(eq(knowledgeArticles.id, a.id))
    const links = await tx.select().from(knowledgeLinks).where(eq(knowledgeLinks.articleId, a.id))
    const { embedding: _e, searchTsv: _t, ...safe } = a
    return { ...safe, links }
  })
}

export async function createArticle(ctx: Ctx, input: { title: string, summary?: string, body: ContentBlock[], categoryId?: string, tags?: string[], visibility?: unknown }) {
  const body = sanitizeBody(input.body)
  const plainText = blocksToText(body)
  const vec = await embed(`${input.title}\n${plainText}`)
  return withTenant(ctx.tenantId, ctx.actorId, async (tx) => {
    const [a] = await tx.insert(knowledgeArticles).values({
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
    }).returning({ id: knowledgeArticles.id, slug: knowledgeArticles.slug })
    await tx.insert(knowledgeRevisions).values({ tenantId: ctx.tenantId, articleId: a!.id, version: 1, title: input.title, body, authorId: ctx.actorId })
    await recordAudit(tx, { tenantId: ctx.tenantId, actorId: ctx.actorId, action: 'knowledge.create', entity: 'knowledge_article', entityId: a!.id, after: { title: input.title } })
    return a!
  })
}

export async function updateArticle(ctx: Ctx, id: string, input: { title?: string, summary?: string, body?: ContentBlock[], categoryId?: string | null, tags?: string[], status?: string, comment?: string }) {
  const body = input.body ? sanitizeBody(input.body) : undefined
  const plainText = body ? blocksToText(body) : undefined
  return withTenant(ctx.tenantId, ctx.actorId, async (tx) => {
    const [before] = await tx.select().from(knowledgeArticles).where(and(eq(knowledgeArticles.id, id), isNull(knowledgeArticles.deletedAt)))
    if (!before) return null
    const contentChanged = body !== undefined || (input.title !== undefined && input.title !== before.title)
    const version = contentChanged ? before.version + 1 : before.version
    const vec = contentChanged ? await embed(`${input.title ?? before.title}\n${plainText ?? before.plainText}`) : undefined

    const [after] = await tx.update(knowledgeArticles).set({
      ...(input.title !== undefined ? { title: input.title } : {}),
      ...(input.summary !== undefined ? { summary: input.summary } : {}),
      ...(body !== undefined ? { body, plainText } : {}),
      ...(input.categoryId !== undefined ? { categoryId: input.categoryId } : {}),
      ...(input.tags !== undefined ? { tags: input.tags } : {}),
      ...(input.status !== undefined ? { status: input.status } : {}),
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

export interface SearchHit {
  kind: 'article' | 'lesson'
  id: string
  title: string
  snippet: string
  score: number
}

/**
 * Гибридный поиск (docs/03 §3.7): FTS по статьям и урокам + семантика по
 * embedding статей (если провайдер подключён). Выдача смешанная, по score.
 * Запрос нормализуется: каждое слово → префикс (риба темп → 'риба':* & 'темп':*).
 */
export async function search(ctx: Ctx, q: string, limit = 20): Promise<SearchHit[]> {
  const words = q.trim().split(/\s+/).filter(w => w.length >= 2).slice(0, 8)
  if (words.length === 0) return []
  const tsq = words.map(w => `${stem(w.replace(/[':&|!()]/g, ''))}:*`).join(' & ')
  const vec = await embed(q)

  return withTenant(ctx.tenantId, ctx.actorId, async (tx) => {
    const articles = await tx.execute(sql`
      select id, title, ts_headline('simple', plain_text, to_tsquery('simple', ${tsq}), 'MaxWords=25, MinWords=10') as snippet,
             ts_rank(search_tsv, to_tsquery('simple', ${tsq})) as score
      from knowledge_articles
      where status = 'published' and deleted_at is null and search_tsv @@ to_tsquery('simple', ${tsq})
      order by score desc limit ${limit}
    `) as unknown as { id: string, title: string, snippet: string, score: number }[]

    const lessons = await tx.execute(sql`
      select r.id, r.title, ts_headline('simple', r.plain_text, to_tsquery('simple', ${tsq}), 'MaxWords=25, MinWords=10') as snippet,
             ts_rank(r.search_tsv, to_tsquery('simple', ${tsq})) as score
      from resources r
      where r.status = 'published' and r.deleted_at is null and r.search_tsv @@ to_tsquery('simple', ${tsq})
      order by score desc limit ${limit}
    `) as unknown as { id: string, title: string, snippet: string, score: number }[]

    let semantic: { id: string, title: string, snippet: string, score: number }[] = []
    if (vec) {
      semantic = await tx.execute(sql`
        select id, title, left(plain_text, 160) as snippet, 1 - (embedding <=> ${`[${vec.join(',')}]`}::vector) as score
        from knowledge_articles
        where status = 'published' and deleted_at is null and embedding is not null
        order by embedding <=> ${`[${vec.join(',')}]`}::vector limit ${limit}
      `) as unknown as typeof semantic
      semantic = semantic.filter(s => Number(s.score) > 0.75)
    }

    const merged = new Map<string, SearchHit>()
    for (const a of articles) merged.set(`article:${a.id}`, { kind: 'article', id: a.id, title: a.title, snippet: a.snippet, score: Number(a.score) })
    for (const l of lessons) merged.set(`lesson:${l.id}`, { kind: 'lesson', id: l.id, title: l.title, snippet: l.snippet, score: Number(l.score) })
    for (const s of semantic) {
      const key = `article:${s.id}`
      const existing = merged.get(key)
      if (existing) existing.score += Number(s.score) * 0.5
      else merged.set(key, { kind: 'article', id: s.id, title: s.title, snippet: s.snippet, score: Number(s.score) * 0.5 })
    }
    return [...merged.values()].sort((a, b) => b.score - a.score).slice(0, limit)
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
