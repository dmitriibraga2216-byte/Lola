import { requireScope } from '../../../../../services/access'
import { deleteCriterion } from '../../../../../services/assessment'
import { apiData, apiError } from '../../../../../utils/apiResponse'
export default defineEventHandler(async (event) => {
  const a = await requireScope(event, 'assessment.manage')
  const r = await deleteCriterion({ tenantId: a.tenantId, actorId: a.userId }, getRouterParam(event, 'id')!)
  if (!r.ok) {
    if (r.code === 'in_use') return apiError(event, 409, 'criterion.in_use', 'Критерій стоїть у замороженій анкеті — заповнення вже почалось, склад змінювати не можна', { forms: r.forms })
    return apiError(event, 404, 'not_found', 'Критерій не знайдено')
  }
  return apiData({ ok: true })
})
