import { can, reportScope, requireScope } from '../../../services/access'
import { mysteryReport } from '../../../services/mystery'
import { apiData } from '../../../utils/apiResponse'
/** Отчёт «Тайный покупатель» (docs/20 §9): руководитель точки видит только опубликованные волны своих точек. */
export default defineEventHandler(async (event) => {
  const a = await requireScope(event, 'report.team')
  return apiData(await mysteryReport({ tenantId: a.tenantId, actorId: a.userId }, { canSeeUnpublished: can(a, 'report.tenant'), scope: await reportScope(a) }))
})
