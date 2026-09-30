import { requireScope } from '../../../../services/access'
import { libraryActorOf } from '../../../../services/library'
import { libraryProposalsReport, libraryStaleReport, libraryUsageReport } from '../../../../services/libraryReports'
import { apiData, apiError } from '../../../../utils/apiResponse'
import { libraryValidationFail } from '../../../../utils/libraryErrors'
import { LIBRARY_REPORT_KINDS, libraryReportQuerySchema, type LibraryReportKind } from '../../../../../shared/schemas/library'

/**
 * GET /library/reports/:kind — отчёты библиотеки (docs/v2/31 §9): `usage` «Використання
 * бібліотеки», `stale` «Застарілі посилання», `proposals` «Пропозиції до бібліотеки».
 * Скоуп `library.view` — библиотека общая на тенант (Р-31.6); предложения не-куратор видит
 * только свои. Выгрузка — фоном через `POST /reports/library-<kind>/export` (docs/22 §7.3).
 */
export default defineEventHandler(async (event) => {
  const kind = getRouterParam(event, 'kind') as LibraryReportKind
  if (!(LIBRARY_REPORT_KINDS as readonly string[]).includes(kind)) return apiError(event, 404, 'not_found', 'Звіт не знайдено')
  const a = await requireScope(event, 'library.view')
  const p = libraryReportQuerySchema.safeParse(getQuery(event))
  if (!p.success) return libraryValidationFail(event, p.error, 'Перевірте фільтри звіту')
  const actor = libraryActorOf(a)
  const rows = kind === 'usage'
    ? await libraryUsageReport(actor, p.data)
    : kind === 'stale' ? await libraryStaleReport(actor, p.data) : await libraryProposalsReport(actor, p.data)
  return apiData({ rows })
})
