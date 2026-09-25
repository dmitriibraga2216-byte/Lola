import { requireAccess } from '../../../../../services/access'
import { takeAlternativePath } from '../../../../../services/interview/candidate'
import { interviewAlternativeSchema } from '../../../../../../shared/schemas/interview'
import { apiData } from '../../../../../utils/apiResponse'
import { interviewFail, interviewValidationFail } from '../../../../../utils/interviewErrors'

/**
 * POST /interviews/entry/:quizId/alternative — альтернативный путь без отказа от ИИ: ИИ сейчас
 * недоступен (`docs/v2/30` §7.12, §7.20) или нет микрофона при сценарии без текстовых ответов
 * (`30` §12 п. 1). Рекрутеру — `interview_declined` с причиной; живое собеседование ставит
 * карточку в «На перевірці». Проверяется, что причина правдива сейчас.
 */
export default defineEventHandler(async (event) => {
  const a = await requireAccess(event)
  const p = interviewAlternativeSchema.safeParse(await readBody(event))
  if (!p.success) return interviewValidationFail(event, p.error)
  const r = await takeAlternativePath({ tenantId: a.tenantId, actorId: a.userId }, getRouterParam(event, 'quizId')!, p.data)
  return r.ok ? apiData(r) : interviewFail(event, r.code)
})
