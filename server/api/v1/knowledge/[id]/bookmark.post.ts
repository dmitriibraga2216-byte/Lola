import { bookmarkSchema } from '../../../../../shared/schemas/hub'
import { requireScope } from '../../../../services/access'
import { toggleBookmark } from '../../../../services/hubExtra'
import { apiData, apiError } from '../../../../utils/apiResponse'

/** POST /knowledge/:id/bookmark {contentType} — переключатель закладки (docs/04 §4.13); чужой тенант — 404. */
export default defineEventHandler(async (event) => {
  const a = await requireScope(event, 'learn.view')
  const p = bookmarkSchema.safeParse((await readBody(event)) ?? {})
  if (!p.success) return apiError(event, 400, 'validation_failed', 'Невідомий тип закладки')
  const r = await toggleBookmark({ tenantId: a.tenantId, actorId: a.userId }, p.data.contentType, getRouterParam(event, 'id')!)
  if (!r.ok) return apiError(event, 404, 'not_found', 'Матеріал не знайдено')
  return apiData(r)
})
