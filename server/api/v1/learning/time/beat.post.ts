import { requireScope } from '../../../../services/access'
import { BEAT_RATE, allowTimeRequest, recordBeat } from '../../../../services/learningTime'
import { apiData, apiError } from '../../../../utils/apiResponse'
import { beatSchema } from '../../../../../shared/schemas/learningTime'

/**
 * POST /learning/time/beat — одно биение счётчика времени (docs/v2/37 §7.10–7.11, §10).
 *
 * Тонкий эндпоинт (CLAUDE.md п. 6): разбор → сервис → ответ. Идемпотентен по
 * `(sessionKey, seq)` без `Idempotency-Key` (`41` §5.5): повтор возвращает тот же `credited`
 * и ничего не начисляет. Сколько зачесть — решает сервер по своим часам (п. 3).
 * Ошибки: `422 time.beat_invalid` (биение не разобрано или нарушает протокол сеанса),
 * `404` (элемент или запись на курс не найдены — в том числе чужого тенанта, п. 15), `429`.
 */
export default defineEventHandler(async (event) => {
  const a = await requireScope(event, 'learn.view')
  const p = beatSchema.safeParse(await readBody(event))
  if (!p.success) return apiError(event, 422, 'time.beat_invalid', 'Не вдалося зарахувати час')
  if (!allowTimeRequest(`beat:${a.userId}`, BEAT_RATE.limit, BEAT_RATE.windowMs)) {
    return apiError(event, 429, 'rate_limited', 'Забагато запитів. Спробуйте пізніше')
  }
  const r = await recordBeat({ tenantId: a.tenantId, actorId: a.userId }, p.data)
  if (r.ok) return apiData(r.result)
  if (r.code === 'not_found') return apiError(event, 404, 'not_found', 'Матеріал не знайдено')
  return apiError(event, 422, 'time.beat_invalid', 'Не вдалося зарахувати час')
})
