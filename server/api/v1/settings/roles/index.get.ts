import { requireScope } from '../../../../services/access'
import { listRoles } from '../../../../services/roles'
import { apiData } from '../../../../utils/apiResponse'
/**
 * GET /settings/roles (docs/24 §3.5): роли со счётчиками скоупов и людей.
 * Группы прав для редактора — `GET /settings/roles/scope-groups` (там же объяснено, почему не здесь).
 */
export default defineEventHandler(async (event) => {
  const a = await requireScope(event, 'people.view')
  return apiData(await listRoles({ tenantId: a.tenantId, actorId: a.userId }))
})
