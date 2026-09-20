import { resourceCategorySchema } from '../../../../shared/schemas/resources'
import { requireScope } from '../../../services/access'
import { updateResourceCategory } from '../../../services/resources'
import { apiData, apiError } from '../../../utils/apiResponse'

export default defineEventHandler(async (event) => {
  const a = await requireScope(event, 'course.edit')
  const p = resourceCategorySchema.partial().safeParse(await readBody(event))
  if (!p.success) return apiError(event, 400, 'validation_failed', 'Перевірте поля категорії', { issues: p.error.issues })
  const r = await updateResourceCategory({ tenantId: a.tenantId, actorId: a.userId }, getRouterParam(event, 'id')!, p.data)
  if (!r) return apiError(event, 404, 'not_found', 'Категорію не знайдено')
  return apiData(r)
})
