import { logFilterSchema } from '../../../../shared/schemas/reports'
import { can, requireScope } from '../../../services/access'
import { LOG_KINDS, RETENTION_DAYS, logRows, readLog } from '../../../services/logs'
import type { LogKind } from '../../../services/logs'
import { logSecurity } from '../../../services/securityLog'
import { toXlsx } from '../../../services/reports'
import { apiData, apiError } from '../../../utils/apiResponse'
/** Журналы (docs/22 §5, §13.4): фильтры по периоду, человеку, типу; доступ по audit.view; `format=xlsx` — выгрузка с каркасом первыми колонками. */
export default defineEventHandler(async (event) => {
  const a = await requireScope(event, 'audit.view')
  const kind = getRouterParam(event, 'kind') as LogKind
  if (!LOG_KINDS.includes(kind)) return apiError(event, 404, 'not_found', 'Невідомий журнал')
  const q = logFilterSchema.safeParse(getQuery(event))
  if (!q.success) return apiError(event, 400, 'validation_failed', 'Перевірте фільтри', { issues: q.error.issues })
  const ctx = { tenantId: a.tenantId, actorId: a.userId }
  if (q.data.format === 'xlsx') {
    if (!can(a, 'report.export')) return apiError(event, 403, 'forbidden', 'Немає права на вивантаження')
    const rows = await logRows(ctx, kind, q.data)
    // docs/22 §11: факт выгрузки журнала с персональными данными — в журнал безопасности
    await logSecurity({ tenantId: a.tenantId, userId: a.userId, event: 'export.personal_data', meta: { kind: `log:${kind}`, rows: rows.length } })
    setHeader(event, 'Content-Type', 'application/vnd.openxmlformats-officedocument.spreadsheetml.sheet')
    setHeader(event, 'Content-Disposition', `attachment; filename="lola-log-${kind}.xlsx"`)
    return toXlsx(kind, rows)
  }
  const rows = await readLog(ctx, kind, q.data)
  return apiData({ kind, retentionDays: RETENTION_DAYS[kind], rows })
})
