import { documentTypeUpdateSchema } from '../../../../shared/schemas/personRecords'
import { requireScope } from '../../../services/access'
import { docViewerOf, updateDocumentType } from '../../../services/personDocuments'
import { apiData, apiError } from '../../../utils/apiResponse'
import { documentTypeWriteError } from '../../../utils/personDocumentErrors'

/**
 * Правка типа (docs/v2/38 §3.5). Выключить используемый тип можно (§12: он уходит из формы,
 * документы остаются) — `409 type_in_use` бывает только на удаление.
 */
export default defineEventHandler(async (event) => {
  const access = await requireScope(event, 'person.document.manage')
  const parsed = documentTypeUpdateSchema.safeParse(await readBody(event))
  if (!parsed.success) return apiError(event, 400, 'validation_failed', 'Перевірте поля типу документа', { issues: parsed.error.issues })
  const r = await updateDocumentType({ tenantId: access.tenantId, actorId: access.userId }, await docViewerOf(access), getRouterParam(event, 'id')!, parsed.data)
  if (!r.ok) return documentTypeWriteError(event, r)
  return apiData(r.type)
})
