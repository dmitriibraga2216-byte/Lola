// Алиас docs/04 §4.8: «CRUD /tests/:id/questions» — вопросы теста.
// Сегодня — /questions?quizId= (docs/28 «Spec 04»); :id из пути подставляется в тот же
// сервис, что и старый маршрут, — логика не дублируется.
import { z } from 'zod'
import { requireScope } from '../../../../services/access'
import { listQuestions } from '../../../../services/questions'
import { apiData } from '../../../../utils/apiResponse'

const q = z.object({
  kind: z.string().optional(),
  q: z.string().max(200).optional(),
  tags: z.union([z.string(), z.array(z.string())]).optional().transform(v => v === undefined ? [] : Array.isArray(v) ? v : v.split(',').filter(Boolean)),
})

export default defineEventHandler(async (event) => {
  const a = await requireScope(event, 'question.manage')
  const filter = q.parse(getQuery(event))
  return apiData(await listQuestions({ tenantId: a.tenantId, actorId: a.userId }, { ...filter, quizId: getRouterParam(event, 'id')! }))
})
