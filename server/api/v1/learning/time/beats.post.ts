import { requireScope } from '../../../../services/access'
import { REPLAY_RATE, allowTimeRequest, recordBeats } from '../../../../services/learningTime'
import { apiData, apiError } from '../../../../utils/apiResponse'
import { beatsBatchSchema } from '../../../../../shared/schemas/learningTime'

/**
 * POST /learning/time/beats — пакет до 200 биений, накопленных без связи (docs/v2/37 §7.11
 * «Потеря связи», §10). Пакет пишется одной транзакцией, дедуплицируется по
 * `(sessionKey, seq)`, зачитывается по интервалам `clientTs`; биения несуществующего элемента
 * отбрасываются поштучно (`rejected`), остальные принимаются. Пакет, чьё старейшее биение
 * старше 24 часов, не принимается: `422 time.replay_too_old`, его время — в выброшенном.
 */
export default defineEventHandler(async (event) => {
  const a = await requireScope(event, 'learn.view')
  const p = beatsBatchSchema.safeParse(await readBody(event))
  if (!p.success) return apiError(event, 422, 'time.beat_invalid', 'Не вдалося зарахувати час')
  if (!allowTimeRequest(`beats:${a.userId}`, REPLAY_RATE.limit, REPLAY_RATE.windowMs)) {
    return apiError(event, 429, 'rate_limited', 'Забагато запитів. Спробуйте пізніше')
  }
  const r = await recordBeats({ tenantId: a.tenantId, actorId: a.userId }, p.data)
  if (r.ok) return apiData(r.result)
  return apiError(event, 422, 'time.replay_too_old', 'Час занадто давній і не зараховується', { discarded: r.discarded })
})
