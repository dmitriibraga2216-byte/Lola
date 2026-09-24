import { orgNodeUpdateSchema } from '../../../../../shared/schemas/orgStructure'
import { requireScope } from '../../../../services/access'
import { canEditNode, ORG_ERROR_STATUS, updateNode } from '../../../../services/orgStructure'
import { apiData, apiError } from '../../../../utils/apiResponse'

/** PUT /org-structure/nodes/:id (docs/v2/32 §10, форма §6.1). */
export default defineEventHandler(async (event) => {
  const a = await requireScope(event, 'org.structure.edit')
  const id = getRouterParam(event, 'id')!
  const p = orgNodeUpdateSchema.safeParse(await readBody(event))
  if (!p.success) return apiError(event, 422, 'validation_failed', 'Перевірте поля вузла', { issues: p.error.issues })
  const ctx = { tenantId: a.tenantId, actorId: a.userId }
  const canEditAll = a.grants.some(g => g.scopes.includes('org.structure.edit') && g.scopeType === 'tenant')
  if (!await canEditNode(ctx, id, canEditAll)) return apiError(event, 403, 'forbidden', 'Ви можете змінювати лише свою гілку')
  const r = await updateNode(ctx, id, p.data)
  if (!r.ok) return apiError(event, ORG_ERROR_STATUS[r.code], r.code, 'Не вдалося зберегти вузол', r.detail ? { field: r.detail } : undefined)
  return apiData(r.node)
})
