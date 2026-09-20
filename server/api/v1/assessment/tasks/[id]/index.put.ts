import { requireScope } from '../../../../../services/access'
import { saveAnswers } from '../../../../../services/assessment'
import { assessmentAnswersSchema } from '../../../../../../shared/schemas/assessment'
import { apiData, apiError } from '../../../../../utils/apiResponse'
export default defineEventHandler(async (event) => {
  const a = await requireScope(event, 'assessment.own')
  const p = assessmentAnswersSchema.safeParse(await readBody(event))
  if (!p.success) return apiError(event, 400, 'validation_failed', 'Перевірте відповіді')
  const r = await saveAnswers({ tenantId: a.tenantId, actorId: a.userId }, getRouterParam(event, 'id')!, p.data.answers, p.data.groupComments)
  if (!r) return apiError(event, 409, 'bad_status', 'Анкету вже надіслано або це не ваше завдання')
  if (r.badValue) return apiError(event, 422, 'assessment.bad_value', 'Оцінка має бути одним із значень шкали', { criterionIds: [r.badValue] })
  return apiData(r)
})
