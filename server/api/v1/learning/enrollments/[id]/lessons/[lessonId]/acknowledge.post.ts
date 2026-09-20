import { requireScope } from '../../../../../../../services/access'
import { acknowledgeLesson } from '../../../../../../../services/learning'
import { apiData, apiError } from '../../../../../../../utils/apiResponse'

/** «Я ознайомився» — зачёт ссылки (docs/04 §4.5, Г-11.5). */
export default defineEventHandler(async (event) => {
  const access = await requireScope(event, 'learn.view')
  const result = await acknowledgeLesson({ tenantId: access.tenantId, actorId: access.userId }, getRouterParam(event, 'id')!, getRouterParam(event, 'lessonId')!)
  if (!result) return apiError(event, 404, 'not_found', 'Урок не відкрито')
  return apiData(result)
})
