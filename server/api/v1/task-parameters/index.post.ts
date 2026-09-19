import { taskParameterSchema } from '../../../../shared/schemas/assignments'
import { requireScope } from '../../../services/access'
import { createTaskParameter } from '../../../services/tasks'
import { apiData, apiError } from '../../../utils/apiResponse'

export default defineEventHandler(async (event) => {
  const a = await requireScope(event, 'assignment.create')
  const p = taskParameterSchema.safeParse(await readBody(event))
  if (!p.success) return apiError(event, 400, 'validation_failed', p.error.issues[0]?.message ?? 'Перевірте поля', { issues: p.error.issues })
  const r = await createTaskParameter({ tenantId: a.tenantId, actorId: a.userId }, p.data)
  if (!r) return apiError(event, 409, 'conflict', 'Параметр із такою назвою вже є')
  return apiData(r)
})
