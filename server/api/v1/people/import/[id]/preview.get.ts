import { requireScope } from '../../../../../services/access'
import { getImportJob } from '../../../../../services/importPeople'
import { apiData, apiError } from '../../../../../utils/apiResponse'

/** Предпросмотр (docs/16 §10): строки с действием и ошибками, счётчики. */
export default defineEventHandler(async (event) => {
  const access = await requireScope(event, 'people.import')
  const job = await getImportJob({ tenantId: access.tenantId, actorId: access.userId }, getRouterParam(event, 'id')!)
  if (!job) return apiError(event, 404, 'not_found', 'Імпорт не знайдено')
  const rows = (job.rows as { raw?: unknown }[]).map(({ raw: _raw, ...r }) => r)
  return apiData({ jobId: job.id, status: job.status, stats: job.stats, mapping: job.mapping, options: job.options, rows })
})
