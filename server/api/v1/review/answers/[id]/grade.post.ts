import { gradeSchema } from '../../../../../../shared/schemas/quizzes'
import { requireScope } from '../../../../../services/access'
import { gradeManual } from '../../../../../services/attempts'
import { apiData, apiError } from '../../../../../utils/apiResponse'

export default defineEventHandler(async (event) => {
  const a = await requireScope(event, 'review.grade')
  const p = gradeSchema.safeParse(await readBody(event))
  if (!p.success) return apiError(event, 400, 'validation_failed', 'Вкажіть рішення')
  const r = await gradeManual({ tenantId: a.tenantId, actorId: a.userId }, getRouterParam(event, 'id')!, p.data)
  if (!r.ok) {
    if (r.code === 'not_found') return apiError(event, 404, 'not_found', 'Відповідь не знайдено')
    if (r.code === 'self_review') return apiError(event, 403, 'review.self', 'Не можна перевіряти власну роботу')
    if (r.code === 'assigned_to_other') return apiError(event, 409, 'review.assigned_to_other', 'Відповідь призначено іншому перевіряючому. Попросіть його передати її вам або зверніться до керівника')
    if (r.code === 'already_claimed') return apiError(event, 409, 'already_claimed', 'Цю відповідь зараз перевіряє інший наставник')
    return apiError(event, 409, 'conflict', 'Відповідь уже перевірено')
  }
  return apiData(r)
})
