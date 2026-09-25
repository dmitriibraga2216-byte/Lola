import { z } from 'zod'
import { orgAssignmentEndSchema } from '../../../../../shared/schemas/orgStructure'
import { requireScope } from '../../../../services/access'
import { assignmentNodeOf, canEditNode, endAssignment, ORG_ERROR_STATUS } from '../../../../services/orgStructure'
import { apiData, apiError } from '../../../../utils/apiResponse'

/**
 * DELETE /org-structure/assignments/:id (docs/v2/32 §10): строка не удаляется, а закрывается.
 * Руководитель снимает людей только в своей ветке — та же проверка, что у привязки (`32` §2).
 */
export default defineEventHandler(async (event) => {
  const a = await requireScope(event, 'org.structure.edit')
  const id = z.string().uuid().safeParse(getRouterParam(event, 'id'))
  if (!id.success) return apiError(event, 404, 'not_found', 'Призначення не знайдено')
  const ctx = { tenantId: a.tenantId, actorId: a.userId }
  const nodeId = await assignmentNodeOf(ctx, id.data)
  if (!nodeId) return apiError(event, 404, 'not_found', 'Призначення не знайдено')
  const canEditAll = a.grants.some(g => g.scopes.includes('org.structure.edit') && g.scopeType === 'tenant')
  if (!await canEditNode(ctx, nodeId, canEditAll)) return apiError(event, 403, 'forbidden', 'Ви можете змінювати лише свою гілку')
  const p = orgAssignmentEndSchema.safeParse((await readBody(event).catch(() => ({}))) ?? {})
  const r = await endAssignment(ctx, id.data, p.success ? p.data.endedReason : undefined)
  if (!r.ok) return apiError(event, ORG_ERROR_STATUS[r.code], r.code, 'Призначення не знайдено')
  return apiData({ ok: true })
})
