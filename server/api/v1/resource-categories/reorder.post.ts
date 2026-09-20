import { resourceCategoryReorderSchema } from '../../../../shared/schemas/resources'
import { requireScope } from '../../../services/access'
import { reorderResourceCategories } from '../../../services/resources'
import { apiData, apiError } from '../../../utils/apiResponse'

/** Порядок перетаскиванием: позиция в массиве = sort_order. */
export default defineEventHandler(async (event) => {
  const a = await requireScope(event, 'course.edit')
  const p = resourceCategoryReorderSchema.safeParse(await readBody(event))
  if (!p.success) return apiError(event, 400, 'validation_failed', 'Передайте порядок категорій', { issues: p.error.issues })
  await reorderResourceCategories({ tenantId: a.tenantId, actorId: a.userId }, p.data.ids)
  return apiData({ ok: true })
})
