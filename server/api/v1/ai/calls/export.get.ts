import { getQuery } from 'h3'
import { aiCallsExportSchema } from '../../../../../shared/schemas/ai'
import { can, requireScope } from '../../../../services/access'
import { exportAiCalls } from '../../../../services/ai/calls'
import { toCsv } from '../../../../services/reportExports'
import { toXlsx } from '../../../../services/reports'
import { apiError } from '../../../../utils/apiResponse'

/**
 * GET /ai/calls/export — «Вивантажити журнал» (`docs/v2/30` §5.6): те же фильтры, что у
 * `GET /ai/calls`, файлом `xlsx` или `csv`. Скоуп `ai.audit` плюс `report.export`, как у любой
 * выгрузки (`docs/22` §7). Выхода модели в файле нет, факт выгрузки — в `audit_log`.
 */
export default defineEventHandler(async (event) => {
  const a = await requireScope(event, 'ai.audit')
  if (!can(a, 'report.export')) return apiError(event, 403, 'forbidden', 'Немає права на вивантаження. Зверніться до адміністратора простору')
  const raw = getQuery(event)
  const q = aiCallsExportSchema.safeParse({
    purpose: raw.purpose, status: raw.status, from: raw.from, to: raw.to, format: raw.format,
    costMin: raw.costMin !== undefined && raw.costMin !== '' ? Number(raw.costMin) : undefined,
  })
  if (!q.success) return apiError(event, 400, 'validation_failed', q.error.issues[0]?.message ?? 'Некоректні параметри фільтра', { issues: q.error.issues })
  const { rows, truncated } = await exportAiCalls({ tenantId: a.tenantId, actorId: a.userId }, q.data)
  // Обрезанный файл (`AI_CALLS_EXPORT_MAX` строк) помечается заголовком — для клиентов API
  if (truncated) setHeader(event, 'X-Lola-Truncated', '1')
  if (q.data.format === 'csv') {
    setHeader(event, 'Content-Type', 'text/csv; charset=utf-8')
    setHeader(event, 'Content-Disposition', 'attachment; filename="lola-ai-calls.csv"')
    return toCsv(rows)
  }
  setHeader(event, 'Content-Type', 'application/vnd.openxmlformats-officedocument.spreadsheetml.sheet')
  setHeader(event, 'Content-Disposition', 'attachment; filename="lola-ai-calls.xlsx"')
  return toXlsx('ai-calls', rows)
})
