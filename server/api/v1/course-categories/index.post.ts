import { categorySchema } from '../../../../shared/schemas/settings'
import { requireScope } from '../../../services/access'
import { CategoryOwnerNotFound, createCategory } from '../../../services/categories'
import { apiData, apiError } from '../../../utils/apiResponse'
export default defineEventHandler(async (event) => {
  const a = await requireScope(event, 'course.edit')
  const p = categorySchema.safeParse(await readBody(event))
  if (!p.success) return apiError(event, 400, 'validation_failed', 'Вкажіть назву категорії', { issues: p.error.issues })
  try {
    return apiData(await createCategory({ tenantId: a.tenantId, actorId: a.userId }, p.data))
  }
  catch (err) {
    if (err instanceof CategoryOwnerNotFound) return apiError(event, 404, 'not_found', err.message)
    throw err
  }
})
