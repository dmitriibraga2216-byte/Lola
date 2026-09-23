import { candidateStatusCreateSchema } from '../../../../shared/schemas/candidates'
import { requireScope } from '../../../services/access'
import { createStatus } from '../../../services/candidateStatuses'
import { apiData, apiError } from '../../../utils/apiResponse'

/**
 * POST /candidate-statuses — своя колонка воронки (docs/v2/28 §3.3, §10).
 *
 * `maps_to` обязателен уже в zod: колонка без терминального состояния ломает отчётность —
 * `422 validation_failed` с путём `mapsTo`, а не `422 maps_to.required` отдельным кодом
 * (единый код валидации, docs/v2/44 §5).
 */
export default defineEventHandler(async (event) => {
  const a = await requireScope(event, 'candidate.status.manage')
  const p = candidateStatusCreateSchema.safeParse(await readBody(event))
  if (!p.success) return apiError(event, 422, 'validation_failed', 'Перевірте дані колонки', { issues: p.error.issues })
  const r = await createStatus({ tenantId: a.tenantId, actorId: a.userId }, p.data)
  if (r.ok) return apiData(r.status)
  return apiError(event, 409, 'code.exists', 'Колонка з таким кодом уже є')
})
