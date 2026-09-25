import { z } from 'zod'
import { requireScope } from '../../../../../services/access'
import { failOrgImport, requestOrgImportApply } from '../../../../../services/orgImport'
import { enqueueForTenant } from '../../../../../services/tenantQueue'
import { apiData, apiError } from '../../../../../utils/apiResponse'

const STATUS = { not_found: 404, not_ready: 409, import_in_progress: 409, nothing_to_apply: 422, mapping_invalid: 422 } as const
const MESSAGE = {
  not_found: 'Імпорт не знайдено',
  not_ready: 'Імпорт уже запущено або завершено',
  import_in_progress: 'Інший імпорт оргструктури ще застосовується — дочекайтеся його завершення',
  nothing_to_apply: 'У файлі немає змін для структури — виправте помилки в рядках або завантажте інший файл',
  mapping_invalid: 'Зіставте колонку ключа вузла (external_key) — без неї рядок нікуди прив\'язати',
} as const

/**
 * POST /org-structure/import/:id/apply (docs/v2/32 §10, §11 `org.import_apply`): запуск
 * применения фоновой задачей, ответ — `{ jobId }`; экран опрашивает `GET …/import/:id`.
 */
export default defineEventHandler(async (event) => {
  const a = await requireScope(event, 'org.structure.import')
  const id = z.string().uuid().safeParse(getRouterParam(event, 'id'))
  if (!id.success) return apiError(event, 404, 'not_found', MESSAGE.not_found)
  const r = await requestOrgImportApply({ tenantId: a.tenantId, actorId: a.userId }, id.data)
  if (!r.ok) return apiError(event, STATUS[r.code], r.code, MESSAGE[r.code])
  try {
    await enqueueForTenant('org.import_apply', a.tenantId, { jobId: id.data }, { singletonKey: `org.import:${id.data}` })
  }
  catch (err) {
    console.error('[org.import_apply] enqueue', err)
    await failOrgImport(a.tenantId, id.data, 'queue_unavailable')
    return apiError(event, 503, 'queue_unavailable', 'Фонові задачі зараз недоступні — спробуйте запустити імпорт пізніше')
  }
  return apiData({ jobId: id.data })
})
