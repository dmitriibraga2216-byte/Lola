import { orgChangesQuerySchema } from '../../../../shared/schemas/orgStructure'
import { can, hasTenantGrant, requireAnyScope } from '../../../services/access'
import { editableBranches } from '../../../services/orgStructure'
import { changesExportRows, changesJournal } from '../../../services/orgReports'
import { toCsv } from '../../../services/reportExports'
import { toXlsx } from '../../../services/reports'
import { withTenant } from '../../../utils/withTenant'
import { apiData, apiError } from '../../../utils/apiResponse'

/**
 * GET /org-structure/changes — «Журнал змін структури» (docs/v2/32 §9, §2; `44` Р-OS.7).
 * Весь тенант — `audit.view` или `org.structure.edit` на весь тенант; руководитель со
 * `org.structure.edit` своей ветки — только строки узлов своего поддерева (`32` §2: «видеть журнал
 * изменений структуры — manager ✓ (своя ветка)»). Курсор — id последней строки. Файл — `report.export`.
 */
export default defineEventHandler(async (event) => {
  const a = await requireAnyScope(event, ['audit.view', 'org.structure.edit'])
  const q = orgChangesQuerySchema.safeParse(getQuery(event))
  if (!q.success) return apiError(event, 400, 'validation_failed', 'Перевірте фільтри журналу', { issues: q.error.issues })
  const all = hasTenantGrant(a, 'audit.view') || hasTenantGrant(a, 'org.structure.edit')
  const branches = all ? null : await withTenant(a.tenantId, a.userId, tx => editableBranches(tx, a.userId))
  const { format, ...f } = q.data
  const page = await changesJournal({ tenantId: a.tenantId, actorId: a.userId }, { ...f, branches })
  if (format === 'json') return apiData(page)
  if (!can(a, 'report.export')) return apiError(event, 403, 'forbidden', 'Немає права на вивантаження. Зверніться до адміністратора простору')
  const flat = changesExportRows(page.rows)
  if (format === 'csv') {
    setHeader(event, 'Content-Type', 'text/csv; charset=utf-8')
    setHeader(event, 'Content-Disposition', 'attachment; filename="lola-org-changes.csv"')
    return toCsv(flat)
  }
  setHeader(event, 'Content-Type', 'application/vnd.openxmlformats-officedocument.spreadsheetml.sheet')
  setHeader(event, 'Content-Disposition', 'attachment; filename="lola-org-changes.xlsx"')
  return toXlsx('org-changes', flat)
})
