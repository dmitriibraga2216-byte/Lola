import { requireScope } from '../../../services/access'
import { knowledgeReport } from '../../../services/knowledge'
import { apiData } from '../../../utils/apiResponse'
/** Отчёт «База знань» (docs/21 §9). */
export default defineEventHandler(async (event) => {
  const a = await requireScope(event, 'knowledge.manage')
  return apiData(await knowledgeReport({ tenantId: a.tenantId, actorId: a.userId }))
})
