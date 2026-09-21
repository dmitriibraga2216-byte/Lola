import { passwordChangeSchema } from '../../../../shared/schemas/auth'
import { requireScope } from '../../../services/access'
import { changeOwnPassword } from '../../../services/password'
import type { AuthContext } from '../../../services/session'
import { apiData, apiError } from '../../../utils/apiResponse'

/** POST /me/password — смена собственного пароля (docs/16 §14.5 «Безпека → Зміна пароля»); событие `password.changed`. */
export default defineEventHandler(async (event) => {
  const a = await requireScope(event, 'learn.view')
  const p = passwordChangeSchema.safeParse(await readBody(event))
  if (!p.success) return apiError(event, 400, 'validation_failed', 'Пароль має бути не коротшим за 8 знаків', { issues: p.error.issues })
  const auth = event.context.auth as AuthContext | undefined
  const r = await changeOwnPassword({ tenantId: a.tenantId, actorId: a.userId }, { ...p.data, sessionId: auth?.sessionId })
  if (!r.ok) return apiError(event, r.code === 'wrong_current' || r.code === 'recovery_disabled' ? 403 : 400, r.code, r.message)
  return apiData({ ok: true })
})
