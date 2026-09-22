import { and, eq, isNull } from 'drizzle-orm'
import { resources } from '../../../../db/schema'
import { requireScope } from '../../../../services/access'
import { withTenant } from '../../../../utils/withTenant'
import { ratingAggregate } from '../../../../services/contentRatings'
import { apiData, apiError } from '../../../../utils/apiResponse'

/** Материал из поиска базы знаний — только опубликованный, в режиме чтения. */
export default defineEventHandler(async (event) => {
  const a = await requireScope(event, 'learn.view')
  const [r] = await withTenant(a.tenantId, a.userId, tx => tx.select({ id: resources.id, title: resources.title, body: resources.body })
    .from(resources).where(and(eq(resources.id, getRouterParam(event, 'id')!), eq(resources.status, 'published'), isNull(resources.deletedAt))))
  if (!r) return apiError(event, 404, 'not_found', 'Матеріал не знайдено')
  // «Оцінок: N · середня X» на картці ресурсу (докс/33 D-042)
  const rating = await ratingAggregate({ tenantId: a.tenantId, actorId: a.userId }, 'resource', r.id)
  return apiData({ ...r, rating })
})
