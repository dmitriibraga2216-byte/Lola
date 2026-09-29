import { requireScope } from '../../../services/access'
import { latestScans } from '../../../services/storageScans'
import { apiData } from '../../../utils/apiResponse'

/**
 * `GET /storage/scans` — последние отчёты ночных задач хранилища (docs/v2/34 §7.3, §7.4 п. 2,
 * §7.6 п. 3): политики, файлы без ссылок, сверка с бакетом. Все три — сухой прогон (docs/v2/44
 * §11 Р-S1), поэтому ручка только читает `audit_log` своего тенанта.
 */
export default defineEventHandler(async (event) => {
  const a = await requireScope(event, 'storage.view')
  return apiData(await latestScans({ tenantId: a.tenantId, actorId: a.userId }))
})
