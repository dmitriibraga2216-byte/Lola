import { requireAccess } from '../../../../../services/access'
import { getPersonNote, noteViewerOf } from '../../../../../services/personNotes'
import { apiData, apiError } from '../../../../../utils/apiResponse'

/**
 * Заметка по прямой ссылке (docs/v2/38 §7.6): архивная — только администратору (критерий
 * §13 п. 6). Невидимая смотрящему — `404`: существование не подтверждается. Пишет
 * `person_note.read`, как и лента.
 */
export default defineEventHandler(async (event) => {
  const access = await requireAccess(event)
  const r = await getPersonNote({ tenantId: access.tenantId, actorId: access.userId }, await noteViewerOf(access), getRouterParam(event, 'id')!, getRouterParam(event, 'noteId')!)
  if (!r.ok) return apiError(event, 404, 'not_found', 'Нотатку не знайдено')
  return apiData(r.note)
})
