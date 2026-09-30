import { requireScope } from '../../../services/access'
import { listBlocklist } from '../../../services/contactBlocklist'
import { apiData } from '../../../utils/apiResponse'

/** GET /contact-blocklist — чёрный список контактов тенанта (docs/v2/29 §7.7): только маски, без контактов. */
export default defineEventHandler(async (event) => {
  const a = await requireScope(event, 'candidate.edit')
  return apiData({ items: await listBlocklist({ tenantId: a.tenantId, actorId: a.userId }) })
})
