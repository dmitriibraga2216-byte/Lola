import { noteDeleteSchema } from '../../../../../../shared/schemas/personRecords'
import { requireAccess } from '../../../../../services/access'
import { deletePersonNote, noteViewerOf } from '../../../../../services/personNotes'
import { apiData, apiError } from '../../../../../utils/apiResponse'
import { noteWriteError } from '../../../../../utils/personNoteErrors'

/**
 * Удаление заметки (docs/v2/38 §2, §10): свою — автору, чужую — только администратору и с
 * причиной (`?reason=` или `{reason}` в теле; §7.5).
 */
export default defineEventHandler(async (event) => {
  const access = await requireAccess(event)
  const body = await readBody(event).catch(() => undefined) as { reason?: string } | undefined
  const q = getQuery(event).reason
  const parsed = noteDeleteSchema.safeParse({ reason: body?.reason ?? (typeof q === 'string' && q ? q : undefined) })
  if (!parsed.success) return apiError(event, 422, 'reason_required', 'Причина — від 5 до 300 символів')
  const r = await deletePersonNote({ tenantId: access.tenantId, actorId: access.userId }, await noteViewerOf(access), getRouterParam(event, 'id')!, getRouterParam(event, 'noteId')!, parsed.data.reason)
  if (!r.ok) return noteWriteError(event, r)
  return apiData({ ok: true })
})
