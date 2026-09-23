import { gdprEraseSchema } from '../../../../shared/schemas/people'
import { requireScope } from '../../../services/access'
import { gdprErase } from '../../../services/people'
import { apiData, apiError } from '../../../utils/apiResponse'

/** Видалення персональних даних за запитом (docs/16 §7.9) — лише адміністратор, необоротно. */
export default defineEventHandler(async (event) => {
  const access = await requireScope(event, 'settings.tenant')
  const parsed = gdprEraseSchema.safeParse(await readBody(event))
  if (!parsed.success) return apiError(event, 400, 'validation_failed', 'Вкажіть підставу', { issues: parsed.error.issues })
  const ok = await gdprErase({ tenantId: access.tenantId, actorId: access.userId }, parsed.data.userId, parsed.data.reason)
  if (ok === 'last_owner') return apiError(event, 409, 'last_owner', 'Це власник простору — спочатку передайте володіння іншій людині')
  if (!ok) return apiError(event, 404, 'not_found', 'Людину не знайдено')
  return apiData({ ok: true })
})
