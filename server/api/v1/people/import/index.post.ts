import { requireScope } from '../../../../services/access'
import { parseImportFile, validateImport } from '../../../../services/importPeople'
import { apiData, apiError } from '../../../../utils/apiResponse'

/** Загрузка файла импорта (multipart) → разбор → валидация → предпросмотр. */
export default defineEventHandler(async (event) => {
  const access = await requireScope(event, 'people.import')

  const parts = await readMultipartFormData(event)
  const file = parts?.find(p => p.name === 'file' && p.data)
  if (!file || !file.filename) {
    return apiError(event, 400, 'validation_failed', 'Додайте файл xlsx або csv')
  }
  if (file.data.length > 10 * 1024 * 1024) {
    return apiError(event, 400, 'validation_failed', 'Файл більший за 10 МБ')
  }

  let raw
  try {
    raw = await parseImportFile(file.filename, file.data)
  }
  catch {
    return apiError(event, 400, 'validation_failed', 'Не вдалося розібрати файл. Скористайтесь шаблоном')
  }
  if (raw.length === 0) {
    return apiError(event, 400, 'validation_failed', 'У файлі немає рядків з даними')
  }
  if (raw.length > 5000) {
    return apiError(event, 400, 'validation_failed', 'Не більше 5000 рядків за один імпорт')
  }

  const result = await validateImport(
    { tenantId: access.tenantId, actorId: access.userId },
    file.filename,
    raw,
  )
  return apiData(result)
})
