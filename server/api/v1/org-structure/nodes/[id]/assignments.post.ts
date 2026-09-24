import { orgAssignmentCreateSchema } from '../../../../../../shared/schemas/orgStructure'
import { requireScope } from '../../../../../services/access'
import { assignUser, canEditNode, ORG_ERROR_STATUS } from '../../../../../services/orgStructure'
import { apiData, apiError } from '../../../../../utils/apiResponse'

/**
 * POST /org-structure/nodes/:id/assignments (docs/v2/32 §10, критерий приёмки 1).
 * `409 primary_exists` — у человека уже есть основное подчинение; клиент спрашивает
 * «Перенести сюди?» и повторяет с `transferPrimary`.
 */
export default defineEventHandler(async (event) => {
  const a = await requireScope(event, 'org.structure.edit')
  const id = getRouterParam(event, 'id')!
  const p = orgAssignmentCreateSchema.safeParse(await readBody(event))
  if (!p.success) return apiError(event, 422, 'validation_failed', 'Оберіть співробітника', { issues: p.error.issues })
  const ctx = { tenantId: a.tenantId, actorId: a.userId }
  const canEditAll = a.grants.some(g => g.scopes.includes('org.structure.edit') && g.scopeType === 'tenant')
  if (!await canEditNode(ctx, id, canEditAll)) return apiError(event, 403, 'forbidden', 'Ви можете змінювати лише свою гілку')
  const r = await assignUser(ctx, id, p.data)
  if (!r.ok) return apiError(event, ORG_ERROR_STATUS[r.code], r.code, 'Не вдалося додати співробітника до вузла', r.detail ? { detail: r.detail } : undefined)
  return apiData({ assignmentId: r.assignmentId, node: r.node })
})
