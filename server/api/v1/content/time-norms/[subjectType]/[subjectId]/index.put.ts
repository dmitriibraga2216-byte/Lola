import { requireScope } from '../../../../../../services/access'
import { putTimeNorm } from '../../../../../../services/timeNorms'
import { apiData, apiError } from '../../../../../../utils/apiResponse'
import { timeNormPutSchema, timeNormSubjectSchema } from '../../../../../../../shared/schemas/timeNorms'

/**
 * PUT /content/time-norms/:subjectType/:subjectId — форма «Норма часу елемента» (docs/v2/37 §6.3,
 * §10): `{source: 'author', authorSeconds}` | `{source: 'auto'}` | `{source: 'observed'}` (то же,
 * что «Застосувати»). Норма — свойство материала, её меняет тот, кто правит контент
 * (`course.edit`: автор, администратор). `422 norm.value_range` — вне 1 минуты … 60 часов,
 * `422 norm.sample_too_small` — «За фактом» при выборке меньше 20. Правка — в `audit_log`.
 */
export default defineEventHandler(async (event) => {
  const a = await requireScope(event, 'course.edit')
  const s = timeNormSubjectSchema.safeParse(getRouterParams(event))
  if (!s.success) return apiError(event, 404, 'not_found', 'Елемент не знайдено')
  const p = timeNormPutSchema.safeParse(await readBody(event))
  if (!p.success) return apiError(event, 400, 'validation_failed', p.error.issues[0]?.message ?? 'Перевірте норму')
  const r = await putTimeNorm({ tenantId: a.tenantId, actorId: a.userId }, s.data, p.data)
  if (r.ok) return apiData(r.norm)
  if (r.code === 'value_range') return apiError(event, 422, 'norm.value_range', 'Від 1 хвилини до 60 годин')
  if (r.code === 'sample_too_small') return apiError(event, 422, 'norm.sample_too_small', 'Замало проходжень, щоб узяти час за фактом: потрібно щонайменше 20')
  return apiError(event, 404, 'not_found', 'Елемент не знайдено')
})
