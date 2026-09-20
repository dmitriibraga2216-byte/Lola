import { requireScope } from '../../../services/access'
import { studyHistory } from '../../../services/reportsExtra'
import { apiData } from '../../../utils/apiResponse'
/** «Моя історія навчання» (docs/22 §13.5, docs/04 `/me/study-history`): рейтинг і список пройденого. */
export default defineEventHandler(async (event) => {
  const a = await requireScope(event, 'development.own')
  return apiData(await studyHistory({ tenantId: a.tenantId, actorId: a.userId }, a.userId))
})
