import { requireScope } from '../../../services/access'
import { removeFromBlocklist } from '../../../services/contactBlocklist'
import { apiError } from '../../../utils/apiResponse'

/** DELETE /contact-blocklist/:id — убрать контакт из списка (docs/v2/29 §7.7); чужой тенант — `404`. */
export default defineEventHandler(async (event) => {
  const a = await requireScope(event, 'candidate.edit')
  if (!await removeFromBlocklist({ tenantId: a.tenantId, actorId: a.userId }, getRouterParam(event, 'id')!)) {
    return apiError(event, 404, 'not_found', 'Запис не знайдено')
  }
  setResponseStatus(event, 204)
  return null
})
