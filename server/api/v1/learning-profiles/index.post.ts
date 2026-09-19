import { profileSchema } from '../../../../shared/schemas/assignments'
import { requireScope } from '../../../services/access'
import { createProfile } from '../../../services/automation'
import { apiData, apiError } from '../../../utils/apiResponse'
export default defineEventHandler(async (event) => {
  const a = await requireScope(event, 'course.publish')
  const p = profileSchema.safeParse(await readBody(event))
  if (!p.success) return apiError(event, 400, 'validation_failed', 'Перевірте профіль', { issues: p.error.issues })
  return apiData(await createProfile({ tenantId: a.tenantId, actorId: a.userId }, p.data))
})
