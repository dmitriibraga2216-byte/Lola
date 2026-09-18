import { reorderSchema } from '../../../../shared/schemas/content'
import { requireScope } from '../../../services/access'
import { reorderLessons } from '../../../services/courses'
import { apiData, apiError } from '../../../utils/apiResponse'

export default defineEventHandler(async (event) => {
  const access = await requireScope(event, 'course.edit')
  const parsed = reorderSchema.safeParse(await readBody(event))
  if (!parsed.success) return apiError(event, 400, 'validation_failed', 'Невірний порядок')
  await reorderLessons({ tenantId: access.tenantId, actorId: access.userId }, parsed.data.items)
  return apiData({ ok: true })
})
