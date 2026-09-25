import { requireAccess } from '../../../../services/access'
import { withdrawConsent } from '../../../../services/interview/session'
import { interviewWithdrawSchema } from '../../../../../shared/schemas/interview'
import { interviewFail, interviewValidationFail } from '../../../../utils/interviewErrors'

/**
 * POST /interviews/:sessionId/withdraw — «Припинити співбесіду» и отзыв согласия (`docs/v2/30`
 * §7.6, §10, §13 к. 9): аудио — в корзину с немедленной очисткой в той же транзакции,
 * расшифровки стёрты, попытка не проваленная, рекрутеру и HR — уведомление. `204`.
 */
export default defineEventHandler(async (event) => {
  const a = await requireAccess(event)
  const p = interviewWithdrawSchema.safeParse((await readBody(event).catch(() => ({}))) ?? {})
  if (!p.success) return interviewValidationFail(event, p.error)
  const r = await withdrawConsent({ tenantId: a.tenantId, actorId: a.userId }, getRouterParam(event, 'sessionId')!, p.data.reason ?? null)
  if (!r.ok) return interviewFail(event, r.code)
  setResponseStatus(event, 204)
  return null
})
