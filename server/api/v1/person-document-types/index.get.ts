import { requireAccess } from '../../../services/access'
import { docViewerOf, listDocumentTypes } from '../../../services/personDocuments'

/**
 * Справочник типов документов (docs/v2/38 §3.5, §10). HR видит все, включая выключенные,
 * со счётчиком документов; руководитель — активные `visible_to_manager`; остальные — активные
 * `self_upload`, то есть то, что могут загрузить себе. `meta.canManage` — правит ли смотрящий
 * справочник (только `person.document.manage` на весь тенант): у руководителя точки тот же
 * скоуп, но на точку, и экран не должен предлагать ему кнопки, которые ответят `403`.
 */
export default defineEventHandler(async (event) => {
  const access = await requireAccess(event)
  const viewer = await docViewerOf(access)
  return { data: await listDocumentTypes({ tenantId: access.tenantId, actorId: access.userId }, viewer), meta: { canManage: viewer.typesAdmin } }
})
