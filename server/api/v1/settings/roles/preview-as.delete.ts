import type { AuthContext } from '../../../../services/session'
import { stopPreview } from '../../../../services/previewAs'
import { apiData, apiError } from '../../../../utils/apiResponse'

/** DELETE /settings/roles/preview-as — кнопка «Вихід» на плашці; без перевірки скоупу (як і вихід з impersonate). */
export default defineEventHandler(async (event) => {
  const auth = event.context.auth as AuthContext | undefined
  if (!auth) return apiError(event, 401, 'auth_required', 'Потрібен вхід')
  if (!auth.previewRoleId) return apiError(event, 400, 'not_previewing', 'Зараз немає активного перегляду «як роль»')
  await stopPreview(auth)
  return apiData({ ok: true })
})
