import { requireAccess } from '../../../../../../services/access'
import { noteMediaAccess, signedReadUrl } from '../../../../../../services/media'
import { docViewerOf, personDocumentFile } from '../../../../../../services/personDocuments'
import { apiData, apiError } from '../../../../../../utils/apiResponse'

/**
 * Файл документа человека — только через документ (docs/v2/38 §2): права те же, что на сам
 * документ. Общий `GET /media/:id` файлы `origin='person_document'` не отдаёт. Выдача ссылки
 * на доказательство (обязательный тип) пишется в журнал `media.download` и живёт 120 секунд
 * (`v2/44` В-19). `?redirect=1` — сразу 302 на подписанную ссылку.
 */
export default defineEventHandler(async (event) => {
  const access = await requireAccess(event)
  const ctx = { tenantId: access.tenantId, actorId: access.userId }
  const r = await personDocumentFile(ctx, await docViewerOf(access), getRouterParam(event, 'id')!, getRouterParam(event, 'docId')!)
  if (!r.ok) return apiError(event, 404, 'not_found', 'Файл не знайдено')
  await noteMediaAccess(ctx, r.media)
  const url = await signedReadUrl(r.media.key, r.media.isEvidence)
  if (getQuery(event).redirect) return sendRedirect(event, url, 302)
  return apiData({ url, mime: r.media.mime, name: r.media.originalName })
})
