import { documentTypeCreateSchema } from '../../../../shared/schemas/personRecords'
import { requireScope } from '../../../services/access'
import { createDocumentType, docViewerOf } from '../../../services/personDocuments'
import { apiData, apiError } from '../../../utils/apiResponse'
import { documentTypeWriteError } from '../../../utils/personDocumentErrors'

/** Новый тип документа (docs/v2/38 §3.5): только HR — `person.document.manage` на весь тенант. */
export default defineEventHandler(async (event) => {
  const access = await requireScope(event, 'person.document.manage')
  const parsed = documentTypeCreateSchema.safeParse(await readBody(event))
  if (!parsed.success) return apiError(event, 400, 'validation_failed', 'Перевірте поля типу документа', { issues: parsed.error.issues })
  const r = await createDocumentType({ tenantId: access.tenantId, actorId: access.userId }, await docViewerOf(access), parsed.data)
  if (!r.ok) return documentTypeWriteError(event, r)
  setResponseStatus(event, 201)
  return apiData(r.type)
})
