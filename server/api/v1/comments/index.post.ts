import { commentCreateSchema } from '../../../../shared/schemas/catalog'
import { requireScope } from '../../../services/access'
import { createComment } from '../../../services/comments'
import { apiData, apiError } from '../../../utils/apiResponse'

/** POST /comments — новий коментар до контенту/проходження (докс/10 §14.2): маршрутизується сервером. */
export default defineEventHandler(async (event) => {
  const a = await requireScope(event, 'learn.view')
  const p = commentCreateSchema.safeParse(await readBody(event))
  if (!p.success) return apiError(event, 400, 'validation_failed', 'Перевірте коментар', { issues: p.error.issues })
  return apiData(await createComment({ tenantId: a.tenantId, actorId: a.userId }, p.data))
})
