import { and, eq, isNull, sql } from 'drizzle-orm'
import { contentRatings, knowledgeArticles, resources } from '../db/schema'
import { withTenant } from '../utils/withTenant'
import type { TenantTx } from '../utils/withTenant'
import type { ContentRatingTarget } from '../../shared/enums'

interface Ctx { tenantId: string, actorId: string }

export interface RatingAggregate { count: number, average: number | null, myValue: number | null }

/**
 * Оценка материала читателем (docs/21 §14.1 «Оцінок: N», докс/33 D-042): звезда 1–5, один голос
 * на человека — повторная оценка правит свой же голос (upsert), не влияет на прохождение
 * (CLAUDE.md п. 11 — правил прохождения тут нет, только реакция читателя).
 */

async function contentExists(tx: TenantTx, contentType: ContentRatingTarget, contentId: string): Promise<boolean> {
  if (contentType === 'resource') {
    const [r] = await tx.select({ id: resources.id }).from(resources).where(and(eq(resources.id, contentId), isNull(resources.deletedAt)))
    return !!r
  }
  const [a] = await tx.select({ id: knowledgeArticles.id }).from(knowledgeArticles).where(and(eq(knowledgeArticles.id, contentId), isNull(knowledgeArticles.deletedAt)))
  return !!a
}

async function aggregateIn(tx: TenantTx, ctx: Ctx, contentType: ContentRatingTarget, contentId: string): Promise<RatingAggregate> {
  const [agg] = await tx.execute(sql`
    select count(*)::int as count, avg(value)::numeric(3,2) as average
    from content_ratings where tenant_id = ${ctx.tenantId}::uuid and content_type = ${contentType} and content_id = ${contentId}::uuid
  `) as unknown as { count: number, average: string | null }[]
  const [my] = await tx.select({ value: contentRatings.value }).from(contentRatings)
    .where(and(eq(contentRatings.tenantId, ctx.tenantId), eq(contentRatings.contentType, contentType), eq(contentRatings.contentId, contentId), eq(contentRatings.userId, ctx.actorId)))
  return { count: agg?.count ?? 0, average: agg?.average != null ? Number(agg.average) : null, myValue: my?.value ?? null }
}

/** Агрегат для карточки (докс/33 D-042): «Оцінок: N · середня X» — читает без входа в транзакцию оценки. */
export async function ratingAggregate(ctx: Ctx, contentType: ContentRatingTarget, contentId: string): Promise<RatingAggregate> {
  return withTenant(ctx.tenantId, ctx.actorId, tx => aggregateIn(tx, ctx, contentType, contentId))
}

export async function rateContent(ctx: Ctx, input: { contentType: ContentRatingTarget, contentId: string, value: number }): Promise<RatingAggregate | null> {
  return withTenant(ctx.tenantId, ctx.actorId, async (tx) => {
    if (!(await contentExists(tx, input.contentType, input.contentId))) return null
    await tx.insert(contentRatings).values({
      tenantId: ctx.tenantId, contentType: input.contentType, contentId: input.contentId, userId: ctx.actorId, value: input.value,
    }).onConflictDoUpdate({
      target: [contentRatings.tenantId, contentRatings.contentType, contentRatings.contentId, contentRatings.userId],
      set: { value: input.value, updatedAt: new Date() },
    })
    return aggregateIn(tx, ctx, input.contentType, input.contentId)
  })
}

export async function unrateContent(ctx: Ctx, input: { contentType: ContentRatingTarget, contentId: string }): Promise<RatingAggregate> {
  return withTenant(ctx.tenantId, ctx.actorId, async (tx) => {
    await tx.delete(contentRatings).where(and(
      eq(contentRatings.tenantId, ctx.tenantId),
      eq(contentRatings.contentType, input.contentType),
      eq(contentRatings.contentId, input.contentId),
      eq(contentRatings.userId, ctx.actorId),
    ))
    return aggregateIn(tx, ctx, input.contentType, input.contentId)
  })
}
