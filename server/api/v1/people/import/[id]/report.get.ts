import { requireScope } from '../../../../../services/access'
import { buildImportReport } from '../../../../../services/importPeople'
import { apiError } from '../../../../../utils/apiResponse'

export default defineEventHandler(async (event) => {
  const access = await requireScope(event, 'people.import')
  const buffer = await buildImportReport(
    { tenantId: access.tenantId, actorId: access.userId },
    getRouterParam(event, 'id')!,
  )
  if (!buffer) return apiError(event, 404, 'not_found', 'Імпорт не знайдено')
  setHeader(event, 'Content-Type', 'application/vnd.openxmlformats-officedocument.spreadsheetml.sheet')
  setHeader(event, 'Content-Disposition', 'attachment; filename="lola-import-report.xlsx"')
  return buffer
})
