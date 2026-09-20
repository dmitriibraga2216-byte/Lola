import { resourcePublishSchema } from '../../../../../shared/schemas/resources'
import { requireScope } from '../../../../services/access'
import { publishResource } from '../../../../services/resources'
import { apiData, apiError } from '../../../../utils/apiResponse'

/** POST /resources/:id/publish {changelog?, notifyAssigned} — снимок версии; «Сповістити про оновлення» (docs/11 §14.2). */
export default defineEventHandler(async (event) => {
  const a = await requireScope(event, 'course.publish')
  const p = resourcePublishSchema.safeParse((await readBody(event)) ?? {})
  if (!p.success) return apiError(event, 400, 'validation_failed', 'Перевірте поля публікації', { issues: p.error.issues })
  const r = await publishResource({ tenantId: a.tenantId, actorId: a.userId }, getRouterParam(event, 'id')!, p.data)
  if (!r.ok) {
    if (r.code === 'not_found') return apiError(event, 404, 'not_found', 'Ресурс не знайдено')
    return apiError(event, 422, 'resource.not_publishable', 'Ресурс не готовий до публікації: заповніть вміст за типом і дочекайтесь обробки файлів', { checks: r.checks })
  }
  return apiData(r)
})
