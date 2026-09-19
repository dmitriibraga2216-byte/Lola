import { requireScope } from '../../../../services/access'
import { updateWorkshop } from '../../../../services/workshops'
import { workshopSchema } from '../index.post'
import { apiData, apiError } from '../../../../utils/apiResponse'
export default defineEventHandler(async (event) => {
  const a = await requireScope(event, 'course.edit')
  const p = workshopSchema.partial().safeParse(await readBody(event))
  if (!p.success) return apiError(event, 400, 'validation_failed', 'Перевірте практикум', { issues: p.error.issues })
  const r = await updateWorkshop({ tenantId: a.tenantId, actorId: a.userId }, getRouterParam(event, 'id')!, p.data)
  if (!r) return apiError(event, 404, 'not_found', 'Практикум не знайдено')
  return apiData(r)
})
