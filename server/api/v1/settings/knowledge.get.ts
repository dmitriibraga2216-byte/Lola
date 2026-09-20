import { requireScope } from '../../../services/access'
import { getKnowledgeSettings } from '../../../services/resources'
import { apiData } from '../../../utils/apiResponse'

/** GET /settings/knowledge — «Використовувати обмеження доступу до ресурсів» (мокап KnowledgeAdmin). */
export default defineEventHandler(async (event) => {
  const a = await requireScope(event, 'knowledge.manage')
  return apiData(await getKnowledgeSettings({ tenantId: a.tenantId, actorId: a.userId }))
})
