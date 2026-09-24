import { noteCreateSchema } from '../../../../../../shared/schemas/personRecords'
import { requireAccess } from '../../../../../services/access'
import { createPersonNote, noteViewerOf } from '../../../../../services/personNotes'
import { apiData, apiError } from '../../../../../utils/apiResponse'
import { noteWriteError } from '../../../../../utils/personNoteErrors'

/**
 * «Додати нотатку» (docs/v2/38 §6.1, §10): `{body, category, visibility, isPinned}`.
 * Право — `person.note.write` в области текущей точки человека (решает сервис); о себе
 * писать нельзя (`user_notes_self_chk`).
 */
export default defineEventHandler(async (event) => {
  const access = await requireAccess(event)
  const parsed = noteCreateSchema.safeParse(await readBody(event))
  if (!parsed.success) {
    if (parsed.error.issues.some(i => i.path[0] === 'body')) return apiError(event, 422, 'note_body_invalid', 'Нотатка має містити від 3 до 2000 символів')
    return apiError(event, 400, 'validation_failed', 'Перевірте категорію та видимість', { issues: parsed.error.issues })
  }
  const r = await createPersonNote({ tenantId: access.tenantId, actorId: access.userId }, await noteViewerOf(access), getRouterParam(event, 'id')!, parsed.data)
  if (!r.ok) return noteWriteError(event, r)
  setResponseStatus(event, 201)
  return apiData(r.note)
})
