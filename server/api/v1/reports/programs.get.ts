import { reportScope, requireScope } from '../../../services/access'
import { programsReport } from '../../../services/reports'
import { apiData } from '../../../utils/apiResponse'
/** Звіт з програм (docs/17 §9): человек, программа, текущий шаг, прогресс, срок, статус. */
export default defineEventHandler(async (event) => {
  const a = await requireScope(event, 'report.team')
  const scope = await reportScope(a)
  return apiData(await programsReport({ tenantId: a.tenantId, actorId: a.userId }, scope))
})
