import { archiveSchema } from '../../../../../shared/schemas/people'
import { requireScope } from '../../../../services/access'
import { archivePerson } from '../../../../services/people'
import { apiData, apiError } from '../../../../utils/apiResponse'

/** Архівування з причиною (docs/16 §4, §7.4). */
export default defineEventHandler(async (event) => {
  const access = await requireScope(event, 'people.deactivate')
  const parsed = archiveSchema.safeParse(await readBody(event))
  if (!parsed.success) return apiError(event, 400, 'validation_failed', 'Вкажіть причину', { issues: parsed.error.issues })
  const r = await archivePerson({ tenantId: access.tenantId, actorId: access.userId }, getRouterParam(event, 'id')!, parsed.data)
  if (!r.ok) {
    if (r.code === 'not_found') return apiError(event, 404, 'not_found', 'Людину не знайдено')
    if (r.code === 'last_owner') return apiError(event, 409, 'last_owner', 'Це власник простору — спочатку передайте володіння іншій людині')
    return apiError(event, 409, 'last_admin', 'Це останній адміністратор — спочатку призначте іншого')
  }
  return apiData({ ok: true, cancelled: r.cancelled ?? 0 })
})
