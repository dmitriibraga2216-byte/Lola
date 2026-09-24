import { orgAssignmentEndSchema } from '../../../../../shared/schemas/orgStructure'
import { requireScope } from '../../../../services/access'
import { endAssignment, ORG_ERROR_STATUS } from '../../../../services/orgStructure'
import { apiData, apiError } from '../../../../utils/apiResponse'

/** DELETE /org-structure/assignments/:id (docs/v2/32 §10): строка не удаляется, а закрывается. */
export default defineEventHandler(async (event) => {
  const a = await requireScope(event, 'org.structure.edit')
  const id = getRouterParam(event, 'id')!
  const p = orgAssignmentEndSchema.safeParse((await readBody(event).catch(() => ({}))) ?? {})
  const r = await endAssignment({ tenantId: a.tenantId, actorId: a.userId }, id, p.success ? p.data.endedReason : undefined)
  if (!r.ok) return apiError(event, ORG_ERROR_STATUS[r.code], r.code, 'Призначення не знайдено')
  return apiData({ ok: true })
})
