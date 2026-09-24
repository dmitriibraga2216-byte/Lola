import { categorySchema } from '../../../../shared/schemas/settings'
import { requireScope } from '../../../services/access'
import { CategoryOwnerNotFound, updateCategory } from '../../../services/categories'
import { apiData, apiError } from '../../../utils/apiResponse'
export default defineEventHandler(async (event) => {
  const a = await requireScope(event, 'course.edit')
  const p = categorySchema.partial().safeParse(await readBody(event))
  if (!p.success) return apiError(event, 400, 'validation_failed', 'Перевірте поля', { issues: p.error.issues })
  try {
    const r = await updateCategory({ tenantId: a.tenantId, actorId: a.userId }, getRouterParam(event, 'id')!, p.data)
    if (!r) return apiError(event, 404, 'not_found', 'Категорію не знайдено')
    return apiData(r)
  }
  catch (err) {
    if (err instanceof CategoryOwnerNotFound) return apiError(event, 404, 'not_found', err.message)
    throw err
  }
})
