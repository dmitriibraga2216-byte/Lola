import { passwordSetSchema } from '../../../../../shared/schemas/auth'
import { requireScope } from '../../../../services/access'
import { setPasswordByAdmin } from '../../../../services/password'
import { apiData, apiError } from '../../../../utils/apiResponse'

/** POST /people/:id/password — смена пароля администратором (docs/04 §4.11): отдельный скоуп `people.password`, событие `password.reset_by_admin`. */
export default defineEventHandler(async (event) => {
  const a = await requireScope(event, 'people.password')
  const p = passwordSetSchema.safeParse(await readBody(event))
  if (!p.success) return apiError(event, 400, 'validation_failed', 'Пароль має бути не коротшим за 8 знаків', { issues: p.error.issues })
  const r = await setPasswordByAdmin({ tenantId: a.tenantId, actorId: a.userId }, getRouterParam(event, 'id')!, p.data)
  if (!r.ok) return r.code === 'not_found' ? apiError(event, 404, 'not_found', r.message) : apiError(event, 400, r.code, r.message)
  return apiData({ ok: true })
})
