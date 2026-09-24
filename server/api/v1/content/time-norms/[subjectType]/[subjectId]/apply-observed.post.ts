import { requireScope } from '../../../../../../services/access'
import { applyObservedNorm } from '../../../../../../services/timeNorms'
import { apiData, apiError } from '../../../../../../utils/apiResponse'
import { timeNormSubjectSchema } from '../../../../../../../shared/schemas/timeNorms'

/**
 * POST /content/time-norms/:subjectType/:subjectId/apply-observed — «Застосувати» (docs/v2/37
 * §6.3, §7.13): медиана факта становится нормой только нажатием автора и замораживается в этот
 * момент. `422 norm.sample_too_small` — меньше 20 достоверных прохождений. Правка — в `audit_log`.
 */
export default defineEventHandler(async (event) => {
  const a = await requireScope(event, 'course.edit')
  const s = timeNormSubjectSchema.safeParse(getRouterParams(event))
  if (!s.success) return apiError(event, 404, 'not_found', 'Елемент не знайдено')
  const r = await applyObservedNorm({ tenantId: a.tenantId, actorId: a.userId }, s.data)
  if (r.ok) return apiData(r.norm)
  if (r.code === 'sample_too_small') return apiError(event, 422, 'norm.sample_too_small', 'Замало проходжень, щоб узяти час за фактом: потрібно щонайменше 20')
  return apiError(event, 404, 'not_found', 'Елемент не знайдено')
})
