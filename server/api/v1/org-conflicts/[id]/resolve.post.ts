import { conflictResolveSchema } from '../../../../../shared/schemas/people'
import { requireScope } from '../../../../services/access'
import { resolveOrgConflict } from '../../../../services/journals'
import { apiData, apiError } from '../../../../utils/apiResponse'

/** POST /org-conflicts/:id/resolve — «Вирішено»: принять как есть или закрыть одно из размещений (docs/16 §14, мокап OrgConflicts). */
export default defineEventHandler(async (event) => {
  const a = await requireScope(event, 'people.edit')
  const p = conflictResolveSchema.safeParse(await readBody(event))
  if (!p.success) return apiError(event, 400, 'validation_failed', 'Оберіть дію та розміщення', { issues: p.error.issues })
  const r = await resolveOrgConflict({ tenantId: a.tenantId, actorId: a.userId }, getRouterParam(event, 'id')!, p.data)
  if (!r.ok) {
    if (r.code === 'not_found') return apiError(event, 404, 'not_found', 'Конфлікт не знайдено')
    if (r.code === 'already_resolved') return apiError(event, 409, 'already_resolved', 'Конфлікт уже вирішено')
    if (r.code === 'placement_not_found') return apiError(event, 404, 'not_found', 'Розміщення не знайдено або вже закрите')
    return apiError(event, 400, 'validation_failed', 'Оберіть розміщення, яке закрити')
  }
  return apiData({ ok: true })
})
