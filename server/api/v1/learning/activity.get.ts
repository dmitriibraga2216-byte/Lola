import { requireScope } from '../../../services/access'
import { myWeekActivity } from '../../../services/learning'
import { apiData } from '../../../utils/apiResponse'

/** «Активність за тиждень» в профиле (мокап Profile): события прохождения по дням, Пн–Нд. */
export default defineEventHandler(async (event) => {
  const a = await requireScope(event, 'learn.view')
  return apiData(await myWeekActivity({ tenantId: a.tenantId, actorId: a.userId }))
})
