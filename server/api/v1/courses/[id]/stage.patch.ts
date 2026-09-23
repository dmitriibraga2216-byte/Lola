import { z } from 'zod'
import { requireScope } from '../../../../services/access'
import { setCourseStage } from '../../../../services/lifecycle'
import { apiData, apiError } from '../../../../utils/apiResponse'

const schema = z.object({
  lifecycleStageId: z.string().uuid().nullable(),
  /** Подтверждение из модального окна docs/v2/33 §6.1 («Курс уже проходили N людей… Змінити?»). */
  confirm: z.boolean().optional(),
}).strict()

/**
 * PATCH /courses/:id/stage — присвоение и смена этапа курса (docs/v2/33 §6.1, §7.4, §10).
 *
 * Курс с завершёнными прохождениями заперт (`stage_locked`): смена этапа без подтверждения —
 * `409 course.stage_locked` (критерий приёмки `33` §13 п. 11). Выключенный этап присвоить
 * нельзя — `422 lifecycle.disabled`.
 */
export default defineEventHandler(async (event) => {
  const a = await requireScope(event, 'lifecycle.manage')
  const id = getRouterParam(event, 'id')!
  const p = schema.safeParse(await readBody(event))
  if (!p.success) return apiError(event, 422, 'validation_failed', 'Перевірте етап', { issues: p.error.issues })
  const r = await setCourseStage({ tenantId: a.tenantId, actorId: a.userId }, id, p.data.lifecycleStageId, p.data.confirm)
  if (r === 'not_found') return apiError(event, 404, 'not_found', 'Курс або етап не знайдено')
  if (r === 'stage_disabled') return apiError(event, 422, 'lifecycle.disabled', 'Етап вимкнено в налаштуваннях')
  if (r === 'stage_locked') return apiError(event, 409, 'course.stage_locked', 'Курс уже проходили — зміна етапу потребує підтвердження')
  return apiData(r)
})
