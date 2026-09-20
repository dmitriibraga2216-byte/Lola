import type { AuthContext } from '../../../../services/session'
import { previewAsSchema } from '../../../../../shared/schemas/settings'
import { requireScope } from '../../../../services/access'
import { startPreview } from '../../../../services/previewAs'
import { apiData, apiError } from '../../../../utils/apiResponse'

/** POST /settings/roles/preview-as (docs/24 §3.5, §9): режим перегляду «як роль» без своїх прав понад роль. */
export default defineEventHandler(async (event) => {
  const a = await requireScope(event, 'settings.tenant')
  const p = previewAsSchema.safeParse(await readBody(event))
  if (!p.success) return apiError(event, 400, 'validation_failed', 'Оберіть роль')
  const auth = event.context.auth as AuthContext
  const r = await startPreview(auth, a, p.data.roleId)
  if (!r.ok) {
    if (r.code === 'not_found') return apiError(event, 404, 'not_found', 'Роль не знайдено')
    return apiError(event, 403, 'scope_not_owned', 'Не можна переглянути роль з правами, яких немає у вас самих', r.details)
  }
  return apiData(r.role)
})
