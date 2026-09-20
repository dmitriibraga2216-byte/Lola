import { requireScope } from '../../../services/access'
import { createSurvey } from '../../../services/surveys'
import { pollSchema } from '../../../../shared/schemas/assessment'
import { apiData, apiError } from '../../../utils/apiResponse'
export default defineEventHandler(async (event) => {
  const a = await requireScope(event, 'survey.manage')
  const p = pollSchema.safeParse(await readBody(event))
  if (!p.success) return apiError(event, 400, 'validation_failed', p.error.issues[0]?.message ?? 'Перевірте опитування', { issues: p.error.issues })
  return apiData(await createSurvey({ tenantId: a.tenantId, actorId: a.userId }, p.data))
})
