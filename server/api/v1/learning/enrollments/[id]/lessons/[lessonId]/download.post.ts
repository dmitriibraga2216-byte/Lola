import { requireScope } from '../../../../../../../services/access'
import { markDownloaded } from '../../../../../../../services/learning'
import { apiData, apiError } from '../../../../../../../utils/apiResponse'

/** Документ скачан (Г-11.5: «пролистан до конца либо скачан»). */
export default defineEventHandler(async (event) => {
  const access = await requireScope(event, 'learn.view')
  const result = await markDownloaded({ tenantId: access.tenantId, actorId: access.userId }, getRouterParam(event, 'id')!, getRouterParam(event, 'lessonId')!)
  if (!result) return apiError(event, 404, 'not_found', 'Урок не відкрито')
  return apiData(result)
})
