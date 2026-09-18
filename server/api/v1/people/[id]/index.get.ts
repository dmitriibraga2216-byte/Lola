import { requireScope } from '../../../../services/access'
import { getPerson } from '../../../../services/people'
import { apiData, apiError } from '../../../../utils/apiResponse'

export default defineEventHandler(async (event) => {
  const access = await requireScope(event, 'people.view')
  const person = await getPerson(
    { tenantId: access.tenantId, actorId: access.userId },
    getRouterParam(event, 'id')!,
  )
  if (!person) return apiError(event, 404, 'not_found', 'Людину не знайдено')
  return apiData(person)
})
