import { orgNodeCreateSchema } from '../../../../../shared/schemas/orgStructure'
import { requireScope } from '../../../../services/access'
import { canEditNode, createNode, ORG_ERROR_STATUS } from '../../../../services/orgStructure'
import { apiData, apiError } from '../../../../utils/apiResponse'

/**
 * POST /org-structure/nodes (docs/v2/32 §10). Корневой узел создаёт только тот, у кого
 * `org.structure.edit` на весь тенант (`32` §2): руководитель правит свою ветку, а не сеть.
 */
export default defineEventHandler(async (event) => {
  const a = await requireScope(event, 'org.structure.edit')
  const p = orgNodeCreateSchema.safeParse(await readBody(event))
  if (!p.success) return apiError(event, 422, 'validation_failed', 'Перевірте поля вузла', { issues: p.error.issues })
  const ctx = { tenantId: a.tenantId, actorId: a.userId }
  const canEditAll = a.grants.some(g => g.scopes.includes('org.structure.edit') && g.scopeType === 'tenant')
  if (!await canEditNode(ctx, p.data.parentId ?? null, canEditAll)) return apiError(event, 403, 'forbidden', 'Ви можете змінювати лише свою гілку')
  const r = await createNode(ctx, p.data)
  if (!r.ok) return apiError(event, ORG_ERROR_STATUS[r.code], r.code, 'Не вдалося створити вузол', r.detail ? { field: r.detail } : undefined)
  return apiData(r.node)
})
