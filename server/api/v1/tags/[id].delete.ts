import { requireScope } from '../../../services/access'
import { deleteTag } from '../../../services/tags'
import { apiData, apiError } from '../../../utils/apiResponse'

/** DELETE /tags/:id — используемую метку удалить нельзя (docs/16 §3.3): 409 `in_use` со счётчиком. */
export default defineEventHandler(async (event) => {
  const a = await requireScope(event, 'settings.tenant')
  const r = await deleteTag({ tenantId: a.tenantId, actorId: a.userId }, getRouterParam(event, 'id')!)
  if (!r.ok) {
    if (r.code === 'not_found') return apiError(event, 404, 'not_found', 'Мітку не знайдено')
    return apiError(event, 409, 'in_use', `Мітка використовується (${r.used}) — спочатку зніміть її з обʼєктів`)
  }
  return apiData({ ok: true })
})
