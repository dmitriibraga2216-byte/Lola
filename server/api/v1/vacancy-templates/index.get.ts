import { requireAnyScope } from '../../../services/access'
import { listTemplates } from '../../../services/vacancyTemplates'
import { apiData } from '../../../utils/apiResponse'

/** GET /vacancy-templates — вкладка «Шаблони» (docs/v2/29 §3.4, §5.3, §10). */
export default defineEventHandler(async (event) => {
  const a = await requireAnyScope(event, ['vacancy.template.manage', 'vacancy.view'])
  const items = await listTemplates({ tenantId: a.tenantId, actorId: a.userId })
  return apiData({ items, meta: { total: items.length } })
})
