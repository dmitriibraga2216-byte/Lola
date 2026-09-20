import { publishSchema } from '../../../../../shared/schemas/content'
import { requireScope } from '../../../../services/access'
import { publishCourse } from '../../../../services/courses'
import { apiData, apiError } from '../../../../utils/apiResponse'

export default defineEventHandler(async (event) => {
  const access = await requireScope(event, 'course.publish')
  const parsed = publishSchema.safeParse(await readBody(event))
  if (!parsed.success) {
    return apiError(event, 400, 'validation_failed', 'Опишіть, що змінилось (5–500 символів)')
  }
  const result = await publishCourse(
    { tenantId: access.tenantId, actorId: access.userId },
    getRouterParam(event, 'id')!,
    parsed.data.changelog,
    parsed.data.notifyAssigned,
  )
  if (!result.ok) {
    if (result.code === 'not_found') return apiError(event, 404, 'not_found', 'Курс не знайдено')
    return apiError(event, 422, 'course.not_publishable', 'Не пройдені перевірки публікації', {
      checks: result.checks,
    })
  }
  return apiData(result)
})
