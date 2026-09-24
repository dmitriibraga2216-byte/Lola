import { documentUpdateSchema } from '../../../../../../../shared/schemas/personRecords'
import { requireAccess } from '../../../../../../services/access'
import { docViewerOf, updatePersonDocument } from '../../../../../../services/personDocuments'
import { apiData, apiError } from '../../../../../../utils/apiResponse'
import { documentWriteError } from '../../../../../../utils/personDocumentErrors'

/** Правка документа (docs/v2/38 §10): срок, отмена с причиной (необратима, §4), примечание. */
export default defineEventHandler(async (event) => {
  const access = await requireAccess(event)
  const parsed = documentUpdateSchema.safeParse(await readBody(event))
  if (!parsed.success) return apiError(event, 400, 'validation_failed', 'Нічого не змінено або поле має неприпустиме значення', { issues: parsed.error.issues })
  const r = await updatePersonDocument({ tenantId: access.tenantId, actorId: access.userId }, await docViewerOf(access), getRouterParam(event, 'id')!, getRouterParam(event, 'docId')!, parsed.data)
  if (!r.ok) return documentWriteError(event, r)
  return apiData(r.document)
})
