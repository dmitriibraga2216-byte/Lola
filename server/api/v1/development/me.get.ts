import { requireScope } from '../../../services/access'
import { competencyGap, myPlan } from '../../../services/development'
import { myRequests } from '../../../services/requests'
import { apiData } from '../../../utils/apiResponse'
/** «Мій розвиток» (docs/19 §5.1): профиль должности с разрывом, план с целями, заявки. */
export default defineEventHandler(async (event) => {
  const a = await requireScope(event, 'development.own')
  const ctx = { tenantId: a.tenantId, actorId: a.userId }
  const userId = typeof getQuery(event).userId === 'string' && (await import('../../../services/access')).can(a, 'development.team') ? String(getQuery(event).userId) : a.userId
  const [gap, plan, requests] = await Promise.all([competencyGap(ctx, userId), myPlan(ctx, userId), userId === a.userId ? myRequests(ctx) : Promise.resolve(null)])
  return apiData({ userId, gap, ...plan, requests })
})
