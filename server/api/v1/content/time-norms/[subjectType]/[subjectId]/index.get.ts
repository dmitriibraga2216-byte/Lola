import { requireAnyScope } from '../../../../../../services/access'
import { getTimeNorm } from '../../../../../../services/timeNorms'
import { apiData, apiError } from '../../../../../../utils/apiResponse'
import { timeNormSubjectSchema } from '../../../../../../../shared/schemas/timeNorms'

/**
 * GET /content/time-norms/:subjectType/:subjectId — «Розрахунковий час» элемента и его источник
 * (docs/v2/37 §6.3, §10). Норму видят те, кто видит отклонение план/факт (§2): наставник и
 * руководитель (`time.metrics.view`), автор и администратор (`course.edit`). Факт — только агрегат
 * без имён. Чужой тенант и несуществующий элемент — `404` (CLAUDE.md п. 15).
 */
export default defineEventHandler(async (event) => {
  const a = await requireAnyScope(event, ['time.metrics.view', 'course.edit'])
  const p = timeNormSubjectSchema.safeParse(getRouterParams(event))
  if (!p.success) return apiError(event, 404, 'not_found', 'Елемент не знайдено')
  const r = await getTimeNorm({ tenantId: a.tenantId, actorId: a.userId }, p.data)
  if (!r.ok) return apiError(event, 404, 'not_found', 'Елемент не знайдено')
  return apiData(r.norm)
})
