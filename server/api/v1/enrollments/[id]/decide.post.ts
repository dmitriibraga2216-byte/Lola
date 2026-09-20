import { catalogDecideSchema } from '../../../../../shared/schemas/catalog'
import { requireScope } from '../../../../services/access'
import { decideCourseRequest } from '../../../../services/learning'
import { apiData, apiError } from '../../../../utils/apiResponse'

/** POST /enrollments/:id/decide — рішення по заявці на курс через каталог (докс/10 §14.1, приймання заявок). */
export default defineEventHandler(async (event) => {
  const a = await requireScope(event, 'assignment.create')
  const p = catalogDecideSchema.safeParse(await readBody(event))
  if (!p.success) return apiError(event, 400, 'validation_failed', 'Вкажіть рішення', { issues: p.error.issues })
  const r = await decideCourseRequest({ tenantId: a.tenantId, actorId: a.userId }, getRouterParam(event, 'id')!, p.data.approve, p.data.reason)
  if (!r.ok) return r.code === 'not_found' ? apiError(event, 404, 'not_found', 'Заявку не знайдено') : apiError(event, 409, 'enrollment.not_requested', 'Це не заявка або рішення вже ухвалено')
  return apiData(r)
})
