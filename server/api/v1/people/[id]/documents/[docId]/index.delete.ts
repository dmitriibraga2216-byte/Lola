import { requireAccess } from '../../../../../../services/access'
import { softDeleteMedia } from '../../../../../../services/media'
import { deletePersonDocument, docViewerOf } from '../../../../../../services/personDocuments'
import { apiData } from '../../../../../../utils/apiResponse'
import { documentWriteError } from '../../../../../../utils/personDocumentErrors'

/**
 * Удаление документа (docs/v2/38 §10). Обязательный тип — доказательство: `409
 * document_is_evidence`, его отменяют, а не удаляют. Файл остального уходит в корзину тем же
 * мягким удалением, что `DELETE /media/:id` (`v2/44` В-17): объект живёт до `purge_after`.
 */
export default defineEventHandler(async (event) => {
  const access = await requireAccess(event)
  const ctx = { tenantId: access.tenantId, actorId: access.userId }
  const r = await deletePersonDocument(ctx, await docViewerOf(access), getRouterParam(event, 'id')!, getRouterParam(event, 'docId')!)
  if (!r.ok) return documentWriteError(event, r)
  if (r.mediaId) await softDeleteMedia(ctx, r.mediaId, { reason: 'person_document.delete' })
  return apiData({ ok: true })
})
