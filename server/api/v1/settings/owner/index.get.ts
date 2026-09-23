import { requireScope } from '../../../../services/access'
import { ownerCard } from '../../../../services/owner'
import { apiData } from '../../../../utils/apiResponse'

/**
 * GET /settings/owner (docs/01 §1.9.4, docs/24 §3.5): хто власник простору і чи можна
 * володіння забрати. Скоуп — `people.view`, як і в списку ролей: ім'я власника видно всім,
 * хто взагалі бачить людей; змінюють володіння інші ручки.
 */
export default defineEventHandler(async (event) => {
  const a = await requireScope(event, 'people.view')
  return apiData(await ownerCard({ tenantId: a.tenantId, actorId: a.userId }))
})
