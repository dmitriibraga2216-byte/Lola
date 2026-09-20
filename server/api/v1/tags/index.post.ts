import { tagCreateSchema } from '../../../../shared/schemas/people'
import { requireScope } from '../../../services/access'
import { createTag } from '../../../services/tags'
import { apiData, apiError } from '../../../utils/apiResponse'

/** POST /tags — метка с обязательной областью действия (docs/16 §14.2). Справочники правят author и admin (settings.tenant). */
export default defineEventHandler(async (event) => {
  const a = await requireScope(event, 'settings.tenant')
  const p = tagCreateSchema.safeParse(await readBody(event))
  if (!p.success) return apiError(event, 400, 'validation_failed', 'Мітка — до 40 знаків без кутових дужок, область дії обовʼязкова', { issues: p.error.issues })
  const r = await createTag({ tenantId: a.tenantId, actorId: a.userId }, p.data)
  if (!r.ok) return apiError(event, 409, 'duplicate', 'Така мітка в цій області вже є')
  return apiData(r.tag)
})
