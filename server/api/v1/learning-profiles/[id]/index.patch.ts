import { profileSchema } from '../../../../../shared/schemas/assignments'
import { requireScope } from '../../../../services/access'
import { updateProfile } from '../../../../services/automation'
import { apiData, apiError } from '../../../../utils/apiResponse'
export default defineEventHandler(async (event) => {
  const a = await requireScope(event, 'course.publish')
  const p = profileSchema.partial().safeParse(await readBody(event))
  if (!p.success) return apiError(event, 400, 'validation_failed', 'Перевірте профіль')
  const r = await updateProfile({ tenantId: a.tenantId, actorId: a.userId }, getRouterParam(event, 'id')!, p.data)
  if (!r) return apiError(event, 404, 'not_found', 'Профіль не знайдено')
  return apiData(r)
})
