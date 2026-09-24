import { requireScope } from '../../../../../services/access'
import { archiveNode, canEditNode, ORG_ERROR_STATUS } from '../../../../../services/orgStructure'
import { apiData, apiError } from '../../../../../utils/apiResponse'

/** POST /org-structure/nodes/:id/archive (docs/v2/32 §4, §10). Физического удаления нет. */
export default defineEventHandler(async (event) => {
  const a = await requireScope(event, 'org.structure.edit')
  const id = getRouterParam(event, 'id')!
  const ctx = { tenantId: a.tenantId, actorId: a.userId }
  const canEditAll = a.grants.some(g => g.scopes.includes('org.structure.edit') && g.scopeType === 'tenant')
  if (!await canEditNode(ctx, id, canEditAll)) return apiError(event, 403, 'forbidden', 'Ви можете змінювати лише свою гілку')
  const r = await archiveNode(ctx, id)
  if (!r.ok) return apiError(event, ORG_ERROR_STATUS[r.code], r.code, 'Спочатку перенесіть або архівуйте підлеглі вузли')
  return apiData({ ok: true })
})
