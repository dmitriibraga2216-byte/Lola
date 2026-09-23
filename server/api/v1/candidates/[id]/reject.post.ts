import { candidateRejectSchema } from '../../../../../shared/schemas/candidates'
import { requireScope } from '../../../../services/access'
import { viewerOf } from '../../../../services/candidates'
import { rejectCandidate } from '../../../../services/candidateHire'
import { apiData, apiError } from '../../../../utils/apiResponse'

/**
 * POST /candidates/:id/reject — отказ с причиной (docs/v2/28 §6.2, §10).
 * Система никогда не ставит отказ сама (§7.4) — сюда приходит только решение человека.
 */
export default defineEventHandler(async (event) => {
  const a = await requireScope(event, 'candidate.decide')
  const p = candidateRejectSchema.safeParse(await readBody(event))
  if (!p.success) return apiError(event, 422, 'reason.required', 'Вкажіть причину відмови', { issues: p.error.issues })
  const r = await rejectCandidate(viewerOf(a), getRouterParam(event, 'id')!, p.data)
  if (r.ok) return apiData(r.candidate)
  switch (r.code) {
    case 'not_found': return apiError(event, 404, 'not_found', 'Кандидата не знайдено')
    case 'consent_expired': return apiError(event, 409, 'consent.expired', 'Строк згоди на обробку даних завершився')
    case 'not_allowed': return apiError(event, 409, 'candidate.not_active', 'Відмовити можна лише активному кандидату', { from: r.from, to: r.to })
  }
})
