import { z } from 'zod'
import { can, requireScope } from '../../../../services/access'
import { requestExport } from '../../../../services/reportExports'
import { enqueueReportExport } from '../../../../services/queue'
import { apiData, apiError } from '../../../../utils/apiResponse'
/** Фоновая выгрузка (docs/22 §7.3): → exportId, файл придёт уведомлением. */
export default defineEventHandler(async (event) => {
  const a = await requireScope(event, 'report.team')
  if (!can(a, 'report.export')) return apiError(event, 403, 'forbidden', 'Немає права на вивантаження')
  const p = z.object({ filters: z.record(z.unknown()).optional(), format: z.enum(['xlsx', 'csv']).optional() }).safeParse(await readBody(event) ?? {})
  const e = await requestExport({ tenantId: a.tenantId, actorId: a.userId }, { report: getRouterParam(event, 'name')!, filters: p.success ? p.data.filters : {}, format: p.success ? p.data.format : 'xlsx' })
  await enqueueReportExport(a.tenantId, e.id)
  return apiData({ exportId: e.id, status: e.status })
})
