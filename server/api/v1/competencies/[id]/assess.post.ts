import { requireScope } from '../../../../services/access'
import { assessCompetency } from '../../../../services/development'
import { assessCompetencyManualSchema } from '../../../../../shared/schemas/development'
import { apiData, apiError } from '../../../../utils/apiResponse'
/** Ручная оценка компетенции (docs/19 Г-19.2): всегда source=manual, ставит руководитель, с причиной. */
export default defineEventHandler(async (event) => {
  const a = await requireScope(event, 'development.team')
  const p = assessCompetencyManualSchema.safeParse(await readBody(event))
  if (!p.success) return apiError(event, 400, 'validation_failed', 'Перевірте оцінку', { issues: p.error.issues })
  const r = await assessCompetency({ tenantId: a.tenantId, actorId: a.userId }, { ...p.data, competencyId: getRouterParam(event, 'id')! })
  if (!r.ok && r.code === 'self') return apiError(event, 403, 'forbidden', 'Оцінку собі ставити не можна — це робить керівник')
  if (!r.ok && r.code === 'not_found') return apiError(event, 404, 'not_found', 'Компетенцію не знайдено')
  if (!r.ok) return apiError(event, 422, 'validation_failed', 'Рівень поза шкалою компетенції')
  return apiData(r.assessment)
})
