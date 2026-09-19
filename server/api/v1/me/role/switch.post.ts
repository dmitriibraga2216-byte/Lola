import { roleSwitchSchema } from '../../../../../shared/schemas/people'
import { switchRole } from '../../../../services/activeRole'
import type { AuthContext } from '../../../../services/session'
import { apiData, apiError } from '../../../../utils/apiResponse'

/** Переключение активной роли (docs/01 §1.9.2, docs/04 §4.4): только среди своих действующих ролей, без выхода. */
export default defineEventHandler(async (event) => {
  const auth = event.context.auth as AuthContext | undefined
  if (!auth) return apiError(event, 401, 'auth_required', 'Потрібен вхід')
  const parsed = roleSwitchSchema.safeParse(await readBody(event))
  if (!parsed.success) {
    return apiError(event, 400, 'validation_failed', 'Перевірте поля', { issues: parsed.error.issues })
  }
  const r = await switchRole(auth, parsed.data.roleId)
  if (!r.ok) {
    if (r.code === 'no_session') return apiError(event, 400, 'validation_failed', 'Активну роль можна змінити лише в сесії, не за API-токеном')
    return apiError(event, 403, 'forbidden', 'Цієї ролі у вас немає або її термін минув')
  }
  return apiData({ activeRole: r.role, changed: r.changed })
})
