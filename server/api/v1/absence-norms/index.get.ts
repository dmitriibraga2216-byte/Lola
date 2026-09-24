import { absenceNormsQuerySchema } from '../../../../shared/schemas/absences'
import { areaForScope, requireScope } from '../../../services/access'
import { absenceNormsOverview } from '../../../services/absenceNorms'
import { apiData, apiError } from '../../../utils/apiResponse'

/**
 * GET /absence-norms?year= (docs/04 §4.11, docs/v2/38 §5.4, docs/v2/39 П-24.1): норма отпуска и
 * больничного компании на год и переопределения точек области права — блок «Кількість днів
 * відпустки» настроек компании. Скоуп `person.absence.manage` (`38` §2).
 */
export default defineEventHandler(async (event) => {
  const a = await requireScope(event, 'person.absence.manage')
  const q = absenceNormsQuerySchema.safeParse(getQuery(event))
  if (!q.success) return apiError(event, 400, 'validation_failed', 'Рік — від 2020 до 2100', { issues: q.error.issues })
  const area = await areaForScope(a, 'person.absence.manage')
  return apiData(await absenceNormsOverview({ tenantId: a.tenantId, actorId: a.userId }, q.data.year, area))
})
