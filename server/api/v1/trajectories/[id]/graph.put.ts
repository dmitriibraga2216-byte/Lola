import { trajectoryGraphSchema } from '../../../../../shared/schemas/trajectories'
import { requireScope } from '../../../../services/access'
import { putGraph } from '../../../../services/trajectories'
import { apiData, apiError } from '../../../../utils/apiResponse'
/** Полотно целиком (docs/04 §4.10): узлы и связи; в ответе — сохранённый граф и список проблем. */
export default defineEventHandler(async (event) => {
  const a = await requireScope(event, 'program.manage')
  const p = trajectoryGraphSchema.safeParse(await readBody(event))
  if (!p.success) return apiError(event, 400, 'validation_failed', p.error.issues[0]?.message ?? 'Перевірте блоки', { issues: p.error.issues })
  const r = await putGraph({ tenantId: a.tenantId, actorId: a.userId }, getRouterParam(event, 'id')!, p.data)
  if (!r.ok) {
    if (r.code === 'not_found') return apiError(event, 404, 'not_found', 'Траєкторію не знайдено')
    if (r.code === 'published') return apiError(event, 409, 'trajectory.published', 'Опубліковану траєкторію не можна перебудувати — створіть копію і опублікуйте її')
    return apiError(event, 422, 'trajectory.bad_edge', r.message ?? 'Перевірте звʼязки')
  }
  return apiData(r)
})
