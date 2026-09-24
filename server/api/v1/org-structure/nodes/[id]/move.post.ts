import { orgNodeMoveSchema } from '../../../../../../shared/schemas/orgStructure'
import { requireScope } from '../../../../../services/access'
import { canEditNode, moveNode, ORG_ERROR_STATUS } from '../../../../../services/orgStructure'
import { apiData, apiError } from '../../../../../utils/apiResponse'

/**
 * POST /org-structure/nodes/:id/move (docs/v2/32 §10, критерий приёмки 3):
 * `409 cycle_detected` и `409 depth_exceeded` — дерево при этом не меняется.
 * Руководителю drop за пределы своей ветки запрещён с подсказкой (критерий 8).
 */
export default defineEventHandler(async (event) => {
  const a = await requireScope(event, 'org.structure.edit')
  const id = getRouterParam(event, 'id')!
  const p = orgNodeMoveSchema.safeParse(await readBody(event))
  if (!p.success) return apiError(event, 422, 'validation_failed', 'Перевірте параметри перенесення', { issues: p.error.issues })
  const ctx = { tenantId: a.tenantId, actorId: a.userId }
  const canEditAll = a.grants.some(g => g.scopes.includes('org.structure.edit') && g.scopeType === 'tenant')
  if (!await canEditNode(ctx, id, canEditAll) || !await canEditNode(ctx, p.data.parentId, canEditAll)) {
    return apiError(event, 403, 'forbidden', 'Ви можете змінювати лише свою гілку')
  }
  const r = await moveNode(ctx, id, p.data)
  if (!r.ok) return apiError(event, ORG_ERROR_STATUS[r.code], r.code, 'Не вдалося перенести вузол')
  return apiData({ moved: r.moved })
})
