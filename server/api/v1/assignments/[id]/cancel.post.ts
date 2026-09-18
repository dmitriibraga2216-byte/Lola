import { assignmentCancelSchema } from '../../../../../shared/schemas/assignments'
import { requireScope } from '../../../../services/access'
import { cancelAssignment } from '../../../../services/assignments'
import { apiData, apiError } from '../../../../utils/apiResponse'

export default defineEventHandler(async (event) => {
  const a = await requireScope(event, 'assignment.cancel')
  const p = assignmentCancelSchema.safeParse(await readBody(event))
  if (!p.success) return apiError(event, 400, 'validation_failed', 'Вкажіть причину')
  const r = await cancelAssignment({ tenantId: a.tenantId, actorId: a.userId }, getRouterParam(event, 'id')!, p.data)
  if (!r) return apiError(event, 404, 'not_found', 'Призначення не знайдено')
  return apiData(r)
})
