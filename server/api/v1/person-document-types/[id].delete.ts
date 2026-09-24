import { requireScope } from '../../../services/access'
import { deleteDocumentType, docViewerOf } from '../../../services/personDocuments'
import { apiData } from '../../../utils/apiResponse'
import { documentTypeWriteError } from '../../../utils/personDocumentErrors'

/** Удаление типа (docs/v2/38 §3.5): системный — никогда, используемый — `409 type_in_use`. */
export default defineEventHandler(async (event) => {
  const access = await requireScope(event, 'person.document.manage')
  const r = await deleteDocumentType({ tenantId: access.tenantId, actorId: access.userId }, await docViewerOf(access), getRouterParam(event, 'id')!)
  if (!r.ok) return documentTypeWriteError(event, r)
  return apiData({ ok: true })
})
