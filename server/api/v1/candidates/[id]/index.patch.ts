import { candidateUpdateSchema } from '../../../../../shared/schemas/candidates'
import { requireScope } from '../../../../services/access'
import { updateCandidate, viewerOf } from '../../../../services/candidates'
import { apiData, apiError } from '../../../../utils/apiResponse'

/**
 * PATCH /candidates/:id — правка карточки (docs/v2/28 §6.1, §10).
 *
 * `409 conflict` — оптимистическая блокировка по `updated_at` (§12.6): двое двигают одну
 * карточку, проигравший получает актуальное состояние, а не затирает чужую правку молча.
 */
export default defineEventHandler(async (event) => {
  const a = await requireScope(event, 'candidate.edit')
  const p = candidateUpdateSchema.safeParse(await readBody(event))
  if (!p.success) return apiError(event, 422, 'validation_failed', 'Перевірте дані кандидата', { issues: p.error.issues })
  const r = await updateCandidate(viewerOf(a), getRouterParam(event, 'id')!, p.data)
  if (r.ok) return apiData(r.candidate)
  if (r.code === 'not_found') return apiError(event, 404, 'not_found', 'Кандидата не знайдено')
  if (r.code === 'conflict') return apiError(event, 409, 'conflict', 'Картку змінив інший користувач', { candidate: r.candidate })
  return apiError(event, 409, 'candidate.contact_taken', 'Такий номер або пошта вже є у кандидата чи співробітника', { duplicates: r.duplicates })
})
