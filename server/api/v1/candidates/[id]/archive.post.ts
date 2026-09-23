import { candidateArchiveSchema } from '../../../../../shared/schemas/candidates'
import { requireScope } from '../../../../services/access'
import { viewerOf } from '../../../../services/candidates'
import { archiveCandidate, withdrawCandidate } from '../../../../services/candidateHire'
import { apiData, apiError } from '../../../../utils/apiResponse'

/**
 * POST /candidates/:id/archive — ручная архивация (docs/v2/28 §4.2, §10).
 * `?withdraw=true` — самоотвод кандидата: то же закрытие доступа, но другая причина, и
 * отчёт по воронке различает «мы не взяли» и «человек ушёл сам» (§9).
 */
export default defineEventHandler(async (event) => {
  const a = await requireScope(event, 'candidate.decide')
  const p = candidateArchiveSchema.safeParse((await readBody(event)) ?? {})
  if (!p.success) return apiError(event, 422, 'validation_failed', 'Перевірте причину', { issues: p.error.issues })
  const withdraw = String(getQuery(event).withdraw ?? '') === 'true'
  const id = getRouterParam(event, 'id')!
  const viewer = viewerOf(a)
  const r = withdraw ? await withdrawCandidate(viewer, id, p.data) : await archiveCandidate(viewer, id, p.data)
  if (r.ok) return apiData(r.candidate)
  switch (r.code) {
    case 'not_found': return apiError(event, 404, 'not_found', 'Кандидата не знайдено')
    case 'consent_expired': return apiError(event, 409, 'consent.expired', 'Строк згоди на обробку даних завершився')
    case 'not_allowed': return apiError(event, 409, 'candidate.transition_not_allowed', 'Такий перехід заборонено', { from: r.from, to: r.to })
  }
})
