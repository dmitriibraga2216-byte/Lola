import { can, requireScope } from '../../../../../../../services/access'
import { confirmMentor } from '../../../../../../../services/trajectories'
import { apiData, apiError } from '../../../../../../../utils/apiResponse'
/** Узел «Призначити наставника»: наставник (або керівник точки, або адмін) підтверджує крок. */
export default defineEventHandler(async (event) => {
  const a = await requireScope(event, 'learn.view')
  const r = await confirmMentor({ tenantId: a.tenantId, actorId: a.userId }, getRouterParam(event, 'id')!, getRouterParam(event, 'nodeId')!, { isAdmin: can(a, 'assignment.create') })
  if (!r.ok) {
    if (r.code === 'not_found') return apiError(event, 404, 'not_found', 'Крок не знайдено')
    if (r.code === 'not_mentor') return apiError(event, 403, 'trajectory.not_mentor', 'Підтвердити крок може лише наставник цієї людини')
    return apiError(event, 409, 'trajectory.not_waiting', 'Крок не чекає на підтвердження')
  }
  return apiData(r)
})
