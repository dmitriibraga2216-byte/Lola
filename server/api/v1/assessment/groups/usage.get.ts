import { requireScope } from '../../../../services/access'
import { libraryUsage } from '../../../../services/assessment'
import { apiData } from '../../../../utils/apiResponse'
/** «Де використовуються» (мокап CriteriaGroups): в анкетах оцінки · в чек-листах · привʼязано до компетенцій. */
export default defineEventHandler(async (event) => {
  const a = await requireScope(event, 'assessment.manage')
  return apiData(await libraryUsage({ tenantId: a.tenantId, actorId: a.userId }))
})
