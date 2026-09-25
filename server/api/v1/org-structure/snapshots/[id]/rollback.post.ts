import { z } from 'zod'
import { requireScope } from '../../../../../services/access'
import { rollbackToSnapshot } from '../../../../../services/orgSnapshots'
import type { RollbackError } from '../../../../../services/orgSnapshots'
import { apiData, apiError } from '../../../../../utils/apiResponse'

const STATUS: Record<RollbackError, number> = { not_found: 404, rollback_in_progress: 409, import_in_progress: 409, snapshot_invalid: 422 }
const MESSAGE: Record<RollbackError, string> = {
  not_found: 'Знімок не знайдено',
  rollback_in_progress: 'Структуру зараз відкочує інший адміністратор — зачекайте й оновіть сторінку',
  import_in_progress: 'Зараз застосовується імпорт оргструктури — дочекайтеся його завершення',
  snapshot_invalid: 'Знімок пошкоджений — відкотитися до нього не можна. Оберіть інший знімок',
}

/**
 * POST /org-structure/snapshots/:id/rollback (docs/v2/32 §7 п. 7, §10, критерий приёмки 7):
 * дерево и активные назначения — как в снимке, уволенные после снимка не возвращаются, текущее
 * состояние сохраняется снимком «до отката». Чужой тенант — `404` (правило 15).
 */
export default defineEventHandler(async (event) => {
  const a = await requireScope(event, 'org.structure.import')
  const id = z.string().uuid().safeParse(getRouterParam(event, 'id'))
  if (!id.success) return apiError(event, 404, 'not_found', MESSAGE.not_found)
  const r = await rollbackToSnapshot({ tenantId: a.tenantId, actorId: a.userId }, id.data)
  if (!r.ok) return apiError(event, STATUS[r.code], r.code, MESSAGE[r.code])
  return apiData(r.result)
})
