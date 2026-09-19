import { remindersSchema } from '../../../../../shared/schemas/assignments'
import { requireScope } from '../../../../services/access'
import { putReminders } from '../../../../services/tasks'
import { apiData, apiError } from '../../../../utils/apiResponse'

/** PUT /tasks/:id/reminders — модель Г-15.1. */
export default defineEventHandler(async (event) => {
  const a = await requireScope(event, 'assignment.create')
  const p = remindersSchema.partial().safeParse(await readBody(event))
  if (!p.success) return apiError(event, 400, 'validation_failed', p.error.issues[0]?.message ?? 'Перевірте поля', { issues: p.error.issues })
  const r = await putReminders({ tenantId: a.tenantId, actorId: a.userId }, getRouterParam(event, 'id')!, p.data)
  if (!r) return apiError(event, 404, 'not_found', 'Призначення не знайдено')
  return apiData(r)
})
