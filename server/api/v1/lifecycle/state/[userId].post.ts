import { lifecycleStateSetSchema } from '../../../../../shared/schemas/offboarding'
import { requireScope } from '../../../../services/access'
import { setPersonStage } from '../../../../services/lifecycleState'
import { apiData, apiError } from '../../../../utils/apiResponse'

/**
 * POST /lifecycle/state/:userId — ручной перевод человека между этапами (docs/v2/33 §7.6, §10).
 *
 * Право — `lifecycle.manage` (§2: «Видеть этап другого» и «менять перечень» разведены;
 * ручной перевод людей — работа HR, а не наставника). Выключенный этап людей не принимает
 * (§5.2, §7.10) — `422 lifecycle.disabled`.
 */
export default defineEventHandler(async (event) => {
  const a = await requireScope(event, 'lifecycle.manage')
  const p = lifecycleStateSetSchema.safeParse(await readBody(event))
  if (!p.success) return apiError(event, 422, 'validation_failed', 'Перевірте етап і причину', { issues: p.error.issues })
  const r = await setPersonStage({ tenantId: a.tenantId, actorId: a.userId }, getRouterParam(event, 'userId')!, p.data)
  if (r === 'not_found') return apiError(event, 404, 'not_found', 'Людину або етап не знайдено')
  if (r === 'stage_disabled') return apiError(event, 422, 'lifecycle.disabled', 'Етап вимкнено в налаштуваннях')
  if (r === 'same_stage') return apiError(event, 409, 'lifecycle.same_stage', 'Людина вже на цьому етапі')
  return apiData(r)
})
