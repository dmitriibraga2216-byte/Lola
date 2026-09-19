import { requireScope } from '../../../../services/access'
import { getQuestion, questionInSnapshots } from '../../../../services/questions'
import { apiData, apiError } from '../../../../utils/apiResponse'

export default defineEventHandler(async (event) => {
  const a = await requireScope(event, 'question.manage')
  const ctx = { tenantId: a.tenantId, actorId: a.userId }
  const q = await getQuestion(ctx, getRouterParam(event, 'id')!)
  if (!q) return apiError(event, 404, 'not_found', 'Питання не знайдено')
  return apiData({ ...q, inSnapshots: await questionInSnapshots(ctx, q.id) })
})
