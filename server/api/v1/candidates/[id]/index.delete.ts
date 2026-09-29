import { candidateDeleteSchema } from '../../../../../shared/schemas/candidates'
import { requireScope } from '../../../../services/access'
import { viewerOf } from '../../../../services/candidates'
import { deleteCandidate } from '../../../../services/candidateInvite'
import { apiData, apiError } from '../../../../utils/apiResponse'

/**
 * DELETE /candidates/:id — удаление по праву на забвение (docs/v2/28 §2, §7.9, §10).
 *
 * Только `candidate.delete` (HR / Админ, §2); без права — `403` от `requireScope`. Запись не
 * удаляется, а обезличивается тем же `anonymizeCandidate()`, что и ночная `candidate.consent_sweep`:
 * прохождение и оценки остаются статистикой. Нанятый — `409 candidate.hired`. Чужой — `404`.
 */
export default defineEventHandler(async (event) => {
  const a = await requireScope(event, 'candidate.delete')
  const p = candidateDeleteSchema.safeParse((await readBody(event)) ?? {})
  if (!p.success) return apiError(event, 422, 'validation_failed', 'Вкажіть причину видалення', { issues: p.error.issues })
  const r = await deleteCandidate(viewerOf(a), getRouterParam(event, 'id')!, p.data)
  if (r.ok) {
    setResponseStatus(event, 204)
    return apiData({ deleted: true })
  }
  if (r.code === 'hired') return apiError(event, 409, 'candidate.hired', 'Кандидата вже найнято — його дані тепер дані співробітника')
  return apiError(event, 404, 'not_found', 'Кандидата не знайдено')
})
