import { taskParameterValuesSchema } from '../../../../../shared/schemas/assignments'
import { requireScope } from '../../../../services/access'
import { putTaskParameterValues } from '../../../../services/tasks'
import { apiData, apiError } from '../../../../utils/apiResponse'

export default defineEventHandler(async (event) => {
  const a = await requireScope(event, 'assignment.create')
  const p = taskParameterValuesSchema.safeParse(await readBody(event))
  if (!p.success) return apiError(event, 400, 'validation_failed', 'Перевірте значення параметрів', { issues: p.error.issues })
  const r = await putTaskParameterValues({ tenantId: a.tenantId, actorId: a.userId }, getRouterParam(event, 'id')!, p.data)
  if (!r.ok) {
    if (r.code === 'not_found') return apiError(event, 404, 'not_found', 'Призначення не знайдено')
    return apiError(event, 400, 'validation_failed', r.issues[0]?.message ?? 'Перевірте значення параметрів', { issues: r.issues })
  }
  return apiData({ ok: true })
})
