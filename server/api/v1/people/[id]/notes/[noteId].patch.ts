import { noteUpdateSchema } from '../../../../../../shared/schemas/personRecords'
import { requireAccess } from '../../../../../services/access'
import { noteViewerOf, updatePersonNote } from '../../../../../services/personNotes'
import { apiData, apiError } from '../../../../../utils/apiResponse'
import { noteWriteError } from '../../../../../utils/personNoteErrors'

/**
 * Правка заметки (docs/v2/38 §10). Сужение видимости открытой человеку заметки —
 * `409 visibility_narrowing_forbidden` (§4, критерий §13 п. 5): он её уже прочитал.
 */
export default defineEventHandler(async (event) => {
  const access = await requireAccess(event)
  const parsed = noteUpdateSchema.safeParse(await readBody(event))
  if (!parsed.success) {
    if (parsed.error.issues.some(i => i.path[0] === 'body')) return apiError(event, 422, 'note_body_invalid', 'Нотатка має містити від 3 до 2000 символів')
    return apiError(event, 400, 'validation_failed', 'Нічого не змінено або поле має неприпустиме значення', { issues: parsed.error.issues })
  }
  const r = await updatePersonNote({ tenantId: access.tenantId, actorId: access.userId }, await noteViewerOf(access), getRouterParam(event, 'id')!, getRouterParam(event, 'noteId')!, parsed.data)
  if (!r.ok) return noteWriteError(event, r)
  return apiData(r.note)
})
