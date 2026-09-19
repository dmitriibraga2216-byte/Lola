import { requireScope } from '../../../../services/access'
import { listNotes } from '../../../../services/people'
import { apiData } from '../../../../utils/apiResponse'

/** Нотатки HR/керівника — людині не видно (docs/16 §5.2). */
export default defineEventHandler(async (event) => {
  const access = await requireScope(event, 'people.edit')
  return apiData(await listNotes({ tenantId: access.tenantId, actorId: access.userId }, getRouterParam(event, 'id')!))
})
