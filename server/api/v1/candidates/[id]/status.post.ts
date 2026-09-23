import { candidateStatusMoveSchema } from '../../../../../shared/schemas/candidates'
import { requireScope } from '../../../../services/access'
import { moveStatus, viewerOf } from '../../../../services/candidates'
import { apiData, apiError } from '../../../../utils/apiResponse'

/**
 * POST /candidates/:id/status — перенос по колонкам воронки (docs/v2/28 §4, §10).
 *
 * `409 status.same` — кандидат уже в этой колонке. `409 candidate.transition_not_allowed` —
 * переход запрещён §4.2; из `hired` не ведёт ни один (критерий §13 к. 11), а найм делается
 * отдельной транзакцией `POST /candidates/:id/hire` (PR-14), не сменой колонки.
 */
export default defineEventHandler(async (event) => {
  const a = await requireScope(event, 'candidate.decide')
  const p = candidateStatusMoveSchema.safeParse(await readBody(event))
  if (!p.success) return apiError(event, 422, 'validation_failed', 'Перевірте дані переходу', { issues: p.error.issues })
  const r = await moveStatus(viewerOf(a), getRouterParam(event, 'id')!, p.data)
  if (r.ok) return apiData(r.candidate)
  switch (r.code) {
    case 'not_found': return apiError(event, 404, 'not_found', 'Кандидата не знайдено')
    case 'status_not_found': return apiError(event, 404, 'not_found', 'Колонку воронки не знайдено')
    case 'same': return apiError(event, 409, 'status.same', 'Кандидат уже в цій колонці')
    case 'reason_required': return apiError(event, 422, 'reason.required', 'Вкажіть причину відмови')
    case 'not_allowed': return apiError(event, 409, 'candidate.transition_not_allowed', 'Такий перехід заборонено', { from: r.from, to: r.to })
  }
})
