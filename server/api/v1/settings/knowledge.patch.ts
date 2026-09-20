import { z } from 'zod'
import { requireScope } from '../../../services/access'
import { updateKnowledgeSettings } from '../../../services/resources'
import { apiData, apiError } from '../../../utils/apiResponse'

export default defineEventHandler(async (event) => {
  const a = await requireScope(event, 'knowledge.manage')
  const p = z.object({ restrictAccess: z.boolean().optional() }).safeParse(await readBody(event))
  if (!p.success) return apiError(event, 400, 'validation_failed', 'Перевірте значення')
  return apiData(await updateKnowledgeSettings({ tenantId: a.tenantId, actorId: a.userId }, p.data))
})
