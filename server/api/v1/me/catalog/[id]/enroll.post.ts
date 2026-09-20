import { requireScope } from '../../../../../services/access'
import { selfEnroll } from '../../../../../services/learning'
import { apiData, apiError } from '../../../../../utils/apiResponse'

/** POST /me/catalog/:id/enroll (docs/04 §4.4) — самозапис, режим «Вільний доступ через каталог навчання». */
export default defineEventHandler(async (event) => {
  const access = await requireScope(event, 'learn.catalog')
  const result = await selfEnroll({ tenantId: access.tenantId, actorId: access.userId }, getRouterParam(event, 'id')!)
  if (!result.ok) {
    if (result.code === 'not_found') return apiError(event, 404, 'not_found', 'Курс не знайдено')
    if (result.code === 'exists') return apiError(event, 409, 'enrollment.exists', 'Ви вже записані на цей курс')
    if (result.code === 'requires_request') return apiError(event, 422, 'catalog.requires_request', 'Цей курс доступний тільки через заявку')
    return apiError(event, 403, 'catalog.hidden', 'Курс недоступний для самозапису')
  }
  return apiData(result)
})
