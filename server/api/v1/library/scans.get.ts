import { requireScope } from '../../../services/access'
import { latestLibraryScans } from '../../../services/libraryReports'
import { apiData } from '../../../utils/apiResponse'

/**
 * `GET /library/scans` — последние отчёты служебных задач библиотеки (docs/v2/31 §11):
 * `library.orphan_scan` (следы оборванных транзакций, ничего не чинит) и
 * `library.version_retire` (какие версии выведены из оборота). «Отчёт админу» — `library.manage`.
 */
export default defineEventHandler(async (event) => {
  const a = await requireScope(event, 'library.manage')
  return apiData(await latestLibraryScans({ tenantId: a.tenantId, actorId: a.userId }))
})
