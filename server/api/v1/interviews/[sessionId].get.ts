import { requireAccess } from '../../../services/access'
import { getSession } from '../../../services/interview/session'
import { apiData } from '../../../utils/apiResponse'
import { interviewFail } from '../../../utils/interviewErrors'

/**
 * GET /interviews/:sessionId — состояние сессии и текущая реплика (`docs/v2/30` §5.2, §10): вопрос
 * — из снимка попытки без эталона. Чужая сессия — `404`. Ничего не меняет: возврат после обрыва
 * засчитывает первое биение (`POST …/heartbeat`).
 */
export default defineEventHandler(async (event) => {
  const a = await requireAccess(event)
  const r = await getSession({ tenantId: a.tenantId, actorId: a.userId }, getRouterParam(event, 'sessionId')!)
  return r ? apiData(r) : interviewFail(event, 'not_found')
})
