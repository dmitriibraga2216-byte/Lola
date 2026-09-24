import { requireAccess } from '../../../../../services/access'
import { countPersonNotes, noteViewerOf } from '../../../../../services/personNotes'
import { apiData, apiError } from '../../../../../utils/apiResponse'

/**
 * Число для свёрнутой секции «Нотатки (N)» (docs/v2/38 §5.1). Содержание не читается —
 * журнал не пишется: запись `person_note.read` появляется только на разворот.
 */
export default defineEventHandler(async (event) => {
  const access = await requireAccess(event)
  const r = await countPersonNotes({ tenantId: access.tenantId, actorId: access.userId }, await noteViewerOf(access), getRouterParam(event, 'id')!)
  if (!r.ok) {
    return r.code === 'not_found'
      ? apiError(event, 404, 'not_found', 'Людину не знайдено')
      : apiError(event, 403, 'forbidden', 'Немає доступу до нотаток цієї людини')
  }
  return apiData({ total: r.total, canCreate: r.canCreate })
})
