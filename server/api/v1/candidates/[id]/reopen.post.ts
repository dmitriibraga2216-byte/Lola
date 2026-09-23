import { candidateReopenSchema } from '../../../../../shared/schemas/candidates'
import { requireScope } from '../../../../services/access'
import { viewerOf } from '../../../../services/candidates'
import { reopenCandidate } from '../../../../services/candidateHire'
import { apiData, apiError } from '../../../../utils/apiResponse'

/**
 * POST /candidates/:id/reopen — возврат в воронку (docs/v2/28 §4.2, §10).
 *
 * Скоуп — `candidate.delete`: в перечне §2 правами администратора помечены удаление и
 * справочник статусов, а возврат в воронку — решение того же веса. Отдельного скоупа
 * «admin» в системе нет, выдумывать его ради одной ручки не стали.
 * Из `hired` возврата нет ни при каком праве (§4.2, критерий §13 к. 11).
 */
export default defineEventHandler(async (event) => {
  const a = await requireScope(event, 'candidate.delete')
  const p = candidateReopenSchema.safeParse(await readBody(event))
  if (!p.success) return apiError(event, 422, 'validation_failed', 'Вкажіть причину повернення', { issues: p.error.issues })
  const r = await reopenCandidate(viewerOf(a), getRouterParam(event, 'id')!, p.data)
  if (r.ok) return apiData(r.candidate)
  switch (r.code) {
    case 'not_found': return apiError(event, 404, 'not_found', 'Кандидата не знайдено')
    case 'consent_expired': return apiError(event, 409, 'consent.expired', 'Строк згоди завершився — повернути кандидата не можна')
    case 'not_allowed': return apiError(event, 409, 'candidate.transition_not_allowed', 'Такий перехід заборонено', { from: r.from, to: r.to })
  }
})
