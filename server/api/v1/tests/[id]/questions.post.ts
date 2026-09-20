// Алиас docs/04 §4.8: «CRUD /tests/:id/questions» (docs/28 «Spec 04»).
// Сегодня — POST /questions с `quizId` в теле; :id из пути подставляется туда же.
import { questionSchema } from '../../../../../shared/schemas/quizzes'
import { requireScope } from '../../../../services/access'
import { QuestionGroupNotFound, createQuestion } from '../../../../services/questions'
import { apiData, apiError } from '../../../../utils/apiResponse'

export default defineEventHandler(async (event) => {
  const a = await requireScope(event, 'question.manage')
  const body = await readBody(event)
  const p = questionSchema.safeParse({ ...body, quizId: getRouterParam(event, 'id') })
  if (!p.success) return apiError(event, 400, 'validation_failed', p.error.issues[0]?.message ?? 'Перевірте питання', { issues: p.error.issues })
  try {
    return apiData(await createQuestion({ tenantId: a.tenantId, actorId: a.userId }, p.data))
  }
  catch (err) {
    if (err instanceof QuestionGroupNotFound) return apiError(event, 404, 'not_found', err.message)
    throw err
  }
})
