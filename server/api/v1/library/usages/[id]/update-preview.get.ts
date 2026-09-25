import { libraryUpdatePreviewQuerySchema } from '../../../../../../shared/schemas/library'
import { requireScope } from '../../../../../services/access'
import { libraryActorOf } from '../../../../../services/library'
import { updatePreview } from '../../../../../services/libraryUsages'
import { apiData } from '../../../../../utils/apiResponse'
import { libraryFail, libraryValidationFail } from '../../../../../utils/libraryErrors'

/**
 * GET /library/usages/:id/update-preview `?toVersion` — данные диалога «Оновити «…» з v2 до v4»
 * (docs/v2/31 §5.5): changelog каждой пропущенной версии, поблочный diff закреплённой и целевой,
 * тела «було / стало» и число людей, которые уже проходят и останутся на своей версии.
 * Дополняет §10: там у диалога нет своего источника, а считать его на клиенте запрещено (п. 3).
 */
export default defineEventHandler(async (event) => {
  const a = await requireScope(event, 'library.view')
  const q = libraryUpdatePreviewQuerySchema.safeParse(getQuery(event))
  if (!q.success) return libraryValidationFail(event, q.error)
  const r = await updatePreview(libraryActorOf(a), getRouterParam(event, 'id')!, q.data.toVersion)
  if (!r.ok) return libraryFail(event, r.code === 'not_found' ? 'usage_not_found' : r.code)
  return apiData(r.preview)
})
