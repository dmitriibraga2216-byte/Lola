import { requireScope } from '../../../../../services/access'
import { answerQuestion } from '../../../../../services/surveys'
import { pollAnswerRequestSchema } from '../../../../../../shared/schemas/assessment'
import { apiData, apiError } from '../../../../../utils/apiResponse'
/** Відповідь на поточне питання → наступне за правилами або завершення (анонімно — без автора). */
export default defineEventHandler(async (event) => {
  const a = await requireScope(event, 'learn.view')
  const p = pollAnswerRequestSchema.safeParse(await readBody(event))
  if (!p.success) return apiError(event, 400, 'validation_failed', 'Невірна відповідь')
  const r = await answerQuestion({ tenantId: a.tenantId, actorId: a.userId }, getRouterParam(event, 'id')!, p.data.questionId, p.data.answer)
  if (!r.ok) {
    const msg: Record<string, [number, string]> = {
      not_found: [404, 'Опитування не знайдено'], closed: [422, 'Опитування закрито'], already: [409, 'Ви вже відповіли'], wrong_question: [409, 'Це питання зараз не активне — оновіть сторінку'],
      required: [422, 'Дайте відповідь на це питання'], bad_option: [422, 'Оберіть варіант зі списку'], own_not_allowed: [422, 'Свій варіант тут не передбачено'],
      bad_value: [422, 'Оберіть значення зі шкали'], files_not_allowed: [422, 'Файли до цієї відповіді не додаються'],
    }
    const [status, text] = msg[r.code] ?? [422, 'Перевірте відповідь']
    return apiError(event, status, `survey.${r.code}`, text)
  }
  return apiData(r)
})
