import { bankSchema } from '../../../../shared/schemas/quizzes'
import { requireScope } from '../../../services/access'
import { createBank } from '../../../services/questions'
import { apiData, apiError } from '../../../utils/apiResponse'

export default defineEventHandler(async (event) => {
  const a = await requireScope(event, 'question.manage')
  const p = bankSchema.safeParse(await readBody(event))
  if (!p.success) return apiError(event, 400, 'validation_failed', 'Назва банку від 3 символів', { issues: p.error.issues })
  return apiData(await createBank({ tenantId: a.tenantId, actorId: a.userId }, p.data))
})
