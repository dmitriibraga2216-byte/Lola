import { tagUpdateSchema } from '../../../../shared/schemas/people'
import { requireScope } from '../../../services/access'
import { updateTag } from '../../../services/tags'
import { apiData, apiError } from '../../../utils/apiResponse'

/** PATCH /tags/:id — переименование сохраняет связи; область не меняется (docs/16 §3.3, §14.2). */
export default defineEventHandler(async (event) => {
  const a = await requireScope(event, 'settings.tenant')
  const p = tagUpdateSchema.safeParse(await readBody(event))
  if (!p.success) return apiError(event, 400, 'validation_failed', 'Мітка — до 40 знаків без кутових дужок', { issues: p.error.issues })
  const r = await updateTag({ tenantId: a.tenantId, actorId: a.userId }, getRouterParam(event, 'id')!, p.data)
  if (!r.ok) return r.code === 'not_found' ? apiError(event, 404, 'not_found', 'Мітку не знайдено') : apiError(event, 409, 'duplicate', 'Така мітка в цій області вже є')
  return apiData(r.tag)
})
