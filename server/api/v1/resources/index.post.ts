import { resourceCreateSchema } from '../../../../shared/schemas/resources'
import { requireScope } from '../../../services/access'
import { createResource } from '../../../services/resources'
import { apiData, apiError } from '../../../utils/apiResponse'

export default defineEventHandler(async (event) => {
  const a = await requireScope(event, 'course.create')
  const p = resourceCreateSchema.safeParse(await readBody(event))
  if (!p.success) return apiError(event, 400, 'validation_failed', p.error.issues[0]?.message ?? 'Перевірте поля ресурсу', { issues: p.error.issues })
  return apiData(await createResource({ tenantId: a.tenantId, actorId: a.userId }, p.data))
})
