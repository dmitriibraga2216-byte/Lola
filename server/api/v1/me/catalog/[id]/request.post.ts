import { catalogRequestSchema } from '../../../../../../shared/schemas/catalog'
import { requireScope } from '../../../../../services/access'
import { requestEnrollment } from '../../../../../services/learning'
import { apiData, apiError } from '../../../../../utils/apiResponse'

/** POST /me/catalog/:id/request (docs/04 §4.4) — заявка, режим «Подання заявки через каталог навчання» (докс/10 §6.1). */
export default defineEventHandler(async (event) => {
  const access = await requireScope(event, 'learn.catalog')
  const p = catalogRequestSchema.safeParse(await readBody(event).catch(() => ({})))
  if (!p.success) return apiError(event, 400, 'validation_failed', 'Перевірте коментар')
  const result = await requestEnrollment({ tenantId: access.tenantId, actorId: access.userId }, getRouterParam(event, 'id')!, p.data.comment)
  if (!result.ok) {
    if (result.code === 'not_found') return apiError(event, 404, 'not_found', 'Курс не знайдено')
    if (result.code === 'already_requested') return apiError(event, 409, 'enrollment.exists', 'Ви вже подали заявку на цей курс')
    if (result.code === 'not_request_mode') return apiError(event, 422, 'catalog.not_request_mode', 'Цей курс доступний одразу — запишіться без заявки')
    return apiError(event, 403, 'catalog.hidden', 'Курс недоступний для заявки')
  }
  return apiData(result)
})
