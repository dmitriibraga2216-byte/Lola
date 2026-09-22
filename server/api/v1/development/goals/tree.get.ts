import { requireScope } from '../../../../services/access'
import { listGoalTree } from '../../../../services/development'
import { apiData } from '../../../../utils/apiResponse'

/** Дерево цілей «Стратегічний план» (докс/19 §14.4, мокап `Goals`). */
export default defineEventHandler(async (event) => {
  const a = await requireScope(event, 'development.team')
  return apiData(await listGoalTree({ tenantId: a.tenantId, actorId: a.userId }))
})
