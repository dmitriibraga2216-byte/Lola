import { candidateStatusUpdateSchema } from '../../../../../shared/schemas/candidates'
import { requireScope } from '../../../../services/access'
import { updateStatus } from '../../../../services/candidateStatuses'
import { apiData, apiError } from '../../../../utils/apiResponse'

/**
 * PATCH /candidate-statuses/:id — правка колонки (docs/v2/28 §3.3, §10).
 *
 * `403 status.system` — попытка сменить терминальное состояние системной колонки: это
 * переписало бы смысл всех прошлых отчётов. Название, цвет, порядок и активность у неё
 * меняются свободно.
 */
export default defineEventHandler(async (event) => {
  const a = await requireScope(event, 'candidate.status.manage')
  const p = candidateStatusUpdateSchema.safeParse(await readBody(event))
  if (!p.success) return apiError(event, 422, 'validation_failed', 'Перевірте дані колонки', { issues: p.error.issues })
  const r = await updateStatus({ tenantId: a.tenantId, actorId: a.userId }, getRouterParam(event, 'id')!, p.data)
  if (r.ok) return apiData(r.status)
  if (r.code === 'not_found') return apiError(event, 404, 'not_found', 'Колонку не знайдено')
  return apiError(event, 403, 'status.system', 'Системній колонці не можна змінити кінцевий стан')
})
