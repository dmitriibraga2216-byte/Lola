import { noteListQuerySchema } from '../../../../../../shared/schemas/personRecords'
import { requireAccess } from '../../../../../services/access'
import { listPersonNotes, noteViewerOf } from '../../../../../services/personNotes'
import { apiError } from '../../../../../utils/apiResponse'

/**
 * Лента заметок карточки (docs/v2/38 §5.1, §10). Единственный `GET` продукта с побочным
 * эффектом (`docs/v2/41` §5.1): каждая страница пишет `person_note.read` с перечнем `note_ids`
 * и без текста. Скоупа на входе нет — свои открытые заметки человек читает без
 * `person.note.read` (§7.4); права решает сервис. Страницы — ключевой курсор сервера
 * (docs/04 §4.1): `meta.cursor` — следующая, `null` — дальше нет.
 */
export default defineEventHandler(async (event) => {
  const access = await requireAccess(event)
  const q = noteListQuerySchema.safeParse(getQuery(event))
  if (!q.success) return apiError(event, 400, 'validation_failed', 'Курсор або ліміт недійсні — оновіть список', { issues: q.error.issues })
  const r = await listPersonNotes({ tenantId: access.tenantId, actorId: access.userId }, await noteViewerOf(access), getRouterParam(event, 'id')!, q.data)
  if (!r.ok) {
    return r.code === 'not_found'
      ? apiError(event, 404, 'not_found', 'Людину не знайдено')
      : apiError(event, 403, 'forbidden', 'Немає доступу до нотаток цієї людини')
  }
  return { data: r.items, meta: { cursor: r.cursor, limit: q.data.limit, total: r.total, canCreate: r.canCreate } }
})
