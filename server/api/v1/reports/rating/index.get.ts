import { getQuery } from 'h3'
import { engagementReportQuerySchema } from '../../../../../shared/schemas/people'
import { areaForScope, can, requireScope } from '../../../../services/access'
import { auditEngagement, engagementExportRows, engagementIndexRows } from '../../../../services/engagementIndex'
import { toCsv } from '../../../../services/reportExports'
import { toXlsx } from '../../../../services/reports'
import { apiData, apiError } from '../../../../utils/apiResponse'

/**
 * GET /reports/rating — «Індекс залученості» (docs/v2/38 §9 п. 5, §10). Скоуп
 * `person.rating.view_others` в его области (руководитель — свои точки, HR и администратор — весь
 * тенант, §2); порядок — по ПІБ, без места (Р-38.6). Файл — `report.export` и только с `confirm=1`
 * («явна галка» §9 п. 5), первой строкой — «Показник довідковий…»; факт выгрузки — в `audit_log`.
 */
export default defineEventHandler(async (event) => {
  const a = await requireScope(event, 'person.rating.view_others')
  const q = engagementReportQuerySchema.safeParse(getQuery(event))
  if (!q.success) return apiError(event, 400, 'validation_failed', 'Перевірте фільтри звіту', { issues: q.error.issues })
  const ctx = { tenantId: a.tenantId, actorId: a.userId }
  const rows = await engagementIndexRows(ctx, { scope: await areaForScope(a, 'person.rating.view_others'), locationId: q.data.locationId, q: q.data.q })
  if (q.data.format === 'json') return apiData(rows)

  if (!can(a, 'report.export')) return apiError(event, 403, 'forbidden', 'Немає права на вивантаження. Зверніться до адміністратора простору')
  if (q.data.confirm !== '1') return apiError(event, 400, 'validation_failed', 'Підтвердьте, що показник довідковий і не призначений для кадрових рішень')
  await auditEngagement(ctx, 'report.rating.export', { format: q.data.format, rows: rows.length, locationId: q.data.locationId ?? null })
  const flat = engagementExportRows(rows)
  if (q.data.format === 'csv') {
    setHeader(event, 'Content-Type', 'text/csv; charset=utf-8')
    setHeader(event, 'Content-Disposition', 'attachment; filename="lola-engagement-index.csv"')
    return toCsv(flat)
  }
  setHeader(event, 'Content-Type', 'application/vnd.openxmlformats-officedocument.spreadsheetml.sheet')
  setHeader(event, 'Content-Disposition', 'attachment; filename="lola-engagement-index.xlsx"')
  return toXlsx('engagement-index', flat)
})
