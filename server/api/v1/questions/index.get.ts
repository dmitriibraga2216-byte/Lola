import { z } from 'zod'
import { requireScope } from '../../../services/access'
import { listQuestions } from '../../../services/questions'
import { apiData } from '../../../utils/apiResponse'

const q = z.object({
  bankId: z.string().uuid().optional(),
  kind: z.string().optional(),
  q: z.string().max(200).optional(),
  tags: z.union([z.string(), z.array(z.string())]).optional().transform(v => v === undefined ? [] : Array.isArray(v) ? v : v.split(',').filter(Boolean)),
  quizId: z.string().uuid().optional(), // «Питання з іншого тесту»
})

export default defineEventHandler(async (event) => {
  const a = await requireScope(event, 'question.manage')
  return apiData(await listQuestions({ tenantId: a.tenantId, actorId: a.userId }, q.parse(getQuery(event))))
})
