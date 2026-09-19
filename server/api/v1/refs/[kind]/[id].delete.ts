import { requireScope } from '../../../../services/access'
import { REF_KINDS, deleteRef } from '../../../../services/refs'
import type { RefKind } from '../../../../services/refs'
import { apiData, apiError } from '../../../../utils/apiResponse'

export default defineEventHandler(async (event) => {
  const access = await requireScope(event, 'settings.tenant')
  const kind = getRouterParam(event, 'kind') as RefKind
  if (!REF_KINDS.includes(kind)) return apiError(event, 404, 'not_found', 'Невідомий довідник')
  const r = await deleteRef({ tenantId: access.tenantId, actorId: access.userId }, kind, getRouterParam(event, 'id')!)
  if (!r.ok) {
    if (r.code === 'not_found') return apiError(event, 404, 'not_found', 'Запис не знайдено')
    return apiError(event, 409, 'in_use', `Використовується (${r.used}) — деактивуйте або обʼєднайте з іншим значенням`)
  }
  return apiData({ ok: true })
})
