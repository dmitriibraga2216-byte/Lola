import { resourceCategorySchema } from '../../../../shared/schemas/resources'
import { requireScope } from '../../../services/access'
import { createResourceCategory } from '../../../services/resources'
import { apiData, apiError } from '../../../utils/apiResponse'

export default defineEventHandler(async (event) => {
  const a = await requireScope(event, 'course.edit')
  const p = resourceCategorySchema.safeParse(await readBody(event))
  if (!p.success) return apiError(event, 400, 'validation_failed', 'Вкажіть назву категорії', { issues: p.error.issues })
  return apiData(await createResourceCategory({ tenantId: a.tenantId, actorId: a.userId }, p.data))
})
