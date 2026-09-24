import { documentCreateSchema } from '../../../../../../shared/schemas/personRecords'
import { requireAccess } from '../../../../../services/access'
import { createPersonDocument, docViewerOf } from '../../../../../services/personDocuments'
import { apiError } from '../../../../../utils/apiResponse'
import { documentWriteError } from '../../../../../utils/personDocumentErrors'

/**
 * «Додати документ» (docs/v2/38 §6.2, §10). Тип «лише факт» с `mediaId` —
 * `422 document_file_not_allowed`, запись не создаётся (§7.7, критерий §13 п. 7).
 * Истёкший при загрузке — принимается сразу `expired` с предупреждением (§12).
 */
export default defineEventHandler(async (event) => {
  const access = await requireAccess(event)
  const parsed = documentCreateSchema.safeParse(await readBody(event))
  if (!parsed.success) {
    const field = String(parsed.error.issues[0]?.path[0] ?? '')
    if (field === 'typeId') return apiError(event, 422, 'document_type_invalid', 'Оберіть тип документа')
    if (field === 'number') return apiError(event, 422, 'validation_failed', 'Номер задовгий', { field })
    return apiError(event, 400, 'validation_failed', 'Перевірте поля документа', { field, issues: parsed.error.issues })
  }
  const r = await createPersonDocument({ tenantId: access.tenantId, actorId: access.userId }, await docViewerOf(access), getRouterParam(event, 'id')!, parsed.data)
  if (!r.ok) return documentWriteError(event, r)
  setResponseStatus(event, 201)
  return { data: r.document, meta: { warnings: r.warnings } }
})
