import { requireScope } from '../../../services/access'
import { listTrajectories } from '../../../services/trajectories'
import { apiData } from '../../../utils/apiResponse'
export default defineEventHandler(async (event) => {
  const a = await requireScope(event, 'program.manage')
  return apiData(await listTrajectories({ tenantId: a.tenantId, actorId: a.userId }))
})
