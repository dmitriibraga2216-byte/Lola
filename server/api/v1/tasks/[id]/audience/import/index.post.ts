import { requireScope } from '../../../../../../services/access'
import { previewCsv } from '../../../../../../services/tasks'
import { apiData, apiError } from '../../../../../../utils/apiResponse'

/** POST /tasks/:id/audience/import — CSV (Г-15.4): ключ email|phone|external_id, due_at, starts_at → предпросмотр + jobId. */
export default defineEventHandler(async (event) => {
  const a = await requireScope(event, 'assignment.create')
  const parts = await readMultipartFormData(event)
  const file = parts?.find(p => p.name === 'file' && p.data)
  if (!file || !file.filename) return apiError(event, 400, 'validation_failed', 'Додайте файл csv з колонкою email, phone або external_id')
  if (file.data.length > 5 * 1024 * 1024) return apiError(event, 400, 'validation_failed', 'Файл більший за 5 МБ')
  const r = await previewCsv({ tenantId: a.tenantId, actorId: a.userId }, getRouterParam(event, 'id')!, file.filename, file.data)
  if (!r.ok) {
    if (r.code === 'not_found') return apiError(event, 404, 'not_found', 'Призначення не знайдено')
    if (r.code === 'no_key_column') return apiError(event, 422, 'import.no_key', 'У першому рядку має бути колонка email, phone або external_id')
    return apiError(event, 422, 'import.empty', 'У файлі немає рядків із даними')
  }
  return apiData(r)
})
