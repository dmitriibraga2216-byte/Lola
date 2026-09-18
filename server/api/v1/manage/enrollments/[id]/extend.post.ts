import { extendSchema } from '../../../../../../shared/schemas/assignments'
import { requireScope } from '../../../../../services/access'
import { extendEnrollment } from '../../../../../services/assignments'
import { apiData, apiError } from '../../../../../utils/apiResponse'

export default defineEventHandler(async (event) => {
  const a = await requireScope(event, 'assignment.create')
  const p = extendSchema.safeParse(await readBody(event))
  if (!p.success) return apiError(event, 400, 'validation_failed', 'Оберіть дату в майбутньому і опишіть причину', { issues: p.error.issues })
  if (new Date(p.data.dueAt) <= new Date()) return apiError(event, 422, 'due.invalid', 'Оберіть дату в майбутньому')
  const r = await extendEnrollment({ tenantId: a.tenantId, actorId: a.userId }, getRouterParam(event, 'id')!, p.data)
  if (!r) return apiError(event, 404, 'not_found', 'Запис не знайдено')
  return apiData(r)
})
