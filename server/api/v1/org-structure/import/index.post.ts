import { requireScope } from '../../../../services/access'
import { parseOrgImportFile, startOrgImport } from '../../../../services/orgImport'
import type { OrgImportFileError } from '../../../../services/orgImport'
import { apiData, apiError } from '../../../../utils/apiResponse'

const MESSAGE: Record<OrgImportFileError, string> = {
  file_encoding: 'Файл має бути в кодуванні UTF-8 — збережіть CSV як «CSV UTF-8»',
  file_empty: 'У файлі немає рядків з даними',
  too_many_rows: 'Не більше 5000 рядків за один імпорт — розділіть файл',
  file_too_large: 'Файл більший за 5 МБ — розділіть його на частини',
}

/**
 * POST /org-structure/import (docs/v2/32 §6.2, §10): загрузка CSV → разбор → сопоставление
 * колонок по заголовкам → предпросмотр («створити» / «оновити» / «помилка»). Ничего не
 * пишет в дерево: применяет `POST /org-structure/import/:id/apply`.
 */
export default defineEventHandler(async (event) => {
  const a = await requireScope(event, 'org.structure.import')
  const parts = await readMultipartFormData(event)
  const file = parts?.find(p => p.name === 'file' && p.data)
  if (!file || !file.filename) return apiError(event, 400, 'validation_failed', 'Додайте файл CSV')
  if (!/\.csv$/i.test(file.filename)) return apiError(event, 422, 'file_invalid', 'Потрібен файл CSV — такий, як дає «Експорт CSV»')
  const parsed = parseOrgImportFile(file.data)
  if (!parsed.ok) return apiError(event, 422, parsed.code, MESSAGE[parsed.code])
  return apiData(await startOrgImport({ tenantId: a.tenantId, actorId: a.userId }, file.filename, parsed))
})
