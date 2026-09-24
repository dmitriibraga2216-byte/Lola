import { z } from 'zod'
import { can, requireScope } from '../../../../services/access'
import { createToken } from '../../../../services/apiTokens'
import { SCOPES } from '../../../../../shared/domain/roles'
import { apiData, apiError } from '../../../../utils/apiResponse'
const schema = z.object({ name: z.string().min(2).max(100), scopes: z.array(z.enum(SCOPES)).min(1), expiresInDays: z.number().int().min(1).max(3650).nullable().optional() })
/** Токен показывается один раз (docs/09 §9.6). */
export default defineEventHandler(async (event) => {
  const a = await requireScope(event, 'settings.integrations')
  const p = schema.safeParse(await readBody(event))
  if (!p.success) return apiError(event, 400, 'validation_failed', 'Перевірте назву і скоупи', { issues: p.error.issues })
  const r = await createToken({ tenantId: a.tenantId, actorId: a.userId }, p.data, scope => can(a, scope))
  if (!r.ok && r.code === 'scope_not_tokenable') {
    return apiError(event, 422, 'scope_not_tokenable', 'Ці права діють лише у сесії людини і не видаються токену інтеграції', { scopes: r.scopes })
  }
  if (!r.ok) return apiError(event, 422, 'scope_not_held', 'Токену не можна видати право, якого немає у вас самих', { scopes: r.scopes })
  return apiData({ id: r.id, token: r.token })
})
