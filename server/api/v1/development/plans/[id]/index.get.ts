import { requireScope, developmentPlanScope } from '../../../../../services/access'
import { getPlanCard } from '../../../../../services/development'
import { apiData, apiError } from '../../../../../utils/apiResponse'

/** Картка плану для адмінки (докс/31 `DevelopmentPlans`): план + кроки-цілі. */
export default defineEventHandler(async (event) => {
  const a = await requireScope(event, 'development.team')
  const p = await getPlanCard({ tenantId: a.tenantId, actorId: a.userId }, getRouterParam(event, 'id')!)
  if (!p) return apiError(event, 404, 'not_found', 'План не знайдено')
  const scope = await developmentPlanScope(a)
  if (scope !== null && (!p.locationId || !scope.includes(p.locationId))) return apiError(event, 403, 'forbidden', 'Немає доступу')
  return apiData(p)
})
