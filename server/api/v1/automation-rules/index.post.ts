import { ruleSchema } from '../../../../shared/schemas/assignments'
import { requireScope } from '../../../services/access'
import { createRule } from '../../../services/automation'
import { apiData, apiError } from '../../../utils/apiResponse'
export default defineEventHandler(async (event) => {
  const a = await requireScope(event, 'settings.tenant')
  const p = ruleSchema.safeParse(await readBody(event))
  if (!p.success) return apiError(event, 400, 'validation_failed', 'Перевірте правило', { issues: p.error.issues })
  return apiData(await createRule({ tenantId: a.tenantId, actorId: a.userId }, p.data))
})
