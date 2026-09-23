import { assignmentCreateSchema } from '../../../../shared/schemas/assignments'
import { requireScope } from '../../../services/access'
import { createAssignment } from '../../../services/assignments'
import { apiData, apiError } from '../../../utils/apiResponse'

/** POST /tasks — создание назначения любого из одиннадцати типов контента (docs/15 §14.1). */
export default defineEventHandler(async (event) => {
  const a = await requireScope(event, 'assignment.create')
  const p = assignmentCreateSchema.safeParse(await readBody(event))
  if (!p.success) return apiError(event, 400, 'validation_failed', p.error.issues[0]?.message ?? 'Перевірте поля', { issues: p.error.issues })
  const r = await createAssignment({ tenantId: a.tenantId, actorId: a.userId }, p.data)
  if (!r.ok) {
    if (r.code === 'subject_not_found') return apiError(event, 422, 'assignment.subject', 'Оберіть опублікований контент цього типу')
    // docs/v2/33 §7.9, критерий §13 п. 5: этап курса не для кандидатов
    if (r.code === 'not_for_candidate') return apiError(event, 422, 'lifecycle.not_for_candidate', 'Цей етап не можна призначати кандидату')
    return apiError(event, 422, 'assignment.empty_audience', 'Під умову не підпадає жодна людина')
  }
  return apiData(r)
})
