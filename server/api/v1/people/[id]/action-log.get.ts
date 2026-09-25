import { requireScope } from '../../../../services/access'
import { personActionLog } from '../../../../services/people'
import { apiData } from '../../../../utils/apiResponse'

/**
 * Журнал действий человека карточки (docs/16 §5.2 «Активність»): последние 100 записей
 * `audit_log`, где он — автор действия. До PR-34 жил на `GET /people/:id/activity`; этот путь
 * теперь отдаёт карту обучающей активности за год (docs/v2/38 §10), а журнал переехал сюда
 * без изменений — те же данные, тот же скоуп `people.view`.
 */
export default defineEventHandler(async (event) => {
  const access = await requireScope(event, 'people.view')
  return apiData(await personActionLog({ tenantId: access.tenantId, actorId: access.userId }, getRouterParam(event, 'id')!))
})
