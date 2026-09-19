import { audienceBuilderSchema } from '../../../../../../shared/schemas/assignments'
import { requireScope } from '../../../../../services/access'
import { previewBuilder } from '../../../../../services/tasks'
import { apiData, apiError } from '../../../../../utils/apiResponse'

/** «Буде призначено»: сколько попадёт под условие конструктора. */
export default defineEventHandler(async (event) => {
  const a = await requireScope(event, 'assignment.create')
  const p = audienceBuilderSchema.safeParse(await readBody(event))
  if (!p.success) return apiError(event, 400, 'validation_failed', 'Перевірте умову', { issues: p.error.issues })
  const r = await previewBuilder({ tenantId: a.tenantId, actorId: a.userId }, getRouterParam(event, 'id')!, p.data)
  if (!r) return apiError(event, 404, 'not_found', 'Призначення не знайдено')
  return apiData(r)
})
