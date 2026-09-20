import { resourceUpdateSchema } from '../../../../../shared/schemas/resources'
import { requireScope } from '../../../../services/access'
import { updateResource } from '../../../../services/resources'
import { apiData, apiError } from '../../../../utils/apiResponse'

export default defineEventHandler(async (event) => {
  const a = await requireScope(event, 'course.edit')
  const p = resourceUpdateSchema.safeParse(await readBody(event))
  if (!p.success) return apiError(event, 400, 'validation_failed', p.error.issues[0]?.message ?? 'Перевірте поля ресурсу', { issues: p.error.issues })
  const r = await updateResource({ tenantId: a.tenantId, actorId: a.userId }, getRouterParam(event, 'id')!, p.data)
  if (!r.ok) {
    if (r.code === 'not_found') return apiError(event, 404, 'not_found', 'Ресурс не знайдено')
    return apiError(event, 422, 'resource.archived', 'Ресурс в архіві — спочатку поверніть його в чернетки')
  }
  return apiData(r.resource)
})
