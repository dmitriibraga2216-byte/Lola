import { categoryReorderSchema } from '../../../../shared/schemas/settings'
import { requireScope } from '../../../services/access'
import { reorderCategories } from '../../../services/categories'
import { apiData, apiError } from '../../../utils/apiResponse'
/** Порядок перетаскиванием: позиция в массиве = sort. */
export default defineEventHandler(async (event) => {
  const a = await requireScope(event, 'course.edit')
  const p = categoryReorderSchema.safeParse(await readBody(event))
  if (!p.success) return apiError(event, 400, 'validation_failed', 'Передайте порядок категорій', { issues: p.error.issues })
  await reorderCategories({ tenantId: a.tenantId, actorId: a.userId }, p.data.ids)
  return apiData({ ok: true })
})
