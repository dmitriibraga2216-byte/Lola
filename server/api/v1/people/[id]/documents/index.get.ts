import { requireAccess } from '../../../../../services/access'
import { docViewerOf, listPersonDocuments } from '../../../../../services/personDocuments'
import { apiData, apiError } from '../../../../../utils/apiResponse'

/**
 * Блок «Документи (N)» (docs/v2/38 §5.1, §10): документы, заглушки отсутствующих обязательных
 * типов и типы, доступные смотрящему для формы §6.2. Свои документы человек видит без скоупа.
 */
export default defineEventHandler(async (event) => {
  const access = await requireAccess(event)
  const r = await listPersonDocuments({ tenantId: access.tenantId, actorId: access.userId }, await docViewerOf(access), getRouterParam(event, 'id')!)
  if (!r.ok) {
    return r.code === 'not_found'
      ? apiError(event, 404, 'not_found', 'Людину не знайдено')
      : apiError(event, 403, 'forbidden', 'Немає доступу до документів цієї людини')
  }
  return apiData({ items: r.items, missing: r.missing, total: r.total, types: r.types })
})
