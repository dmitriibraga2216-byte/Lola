import { z } from 'zod'
import { requireScope } from '../../../../services/access'
import { createToken } from '../../../../services/apiTokens'
import { SCOPES } from '../../../../../shared/domain/roles'
import { apiData, apiError } from '../../../../utils/apiResponse'
const schema = z.object({ name: z.string().min(2).max(100), scopes: z.array(z.enum(SCOPES)).min(1), expiresInDays: z.number().int().min(1).max(3650).nullable().optional() })
/** Токен показывается один раз (docs/09 §9.6). */
export default defineEventHandler(async (event) => {
  const a = await requireScope(event, 'settings.integrations')
  const p = schema.safeParse(await readBody(event))
  if (!p.success) return apiError(event, 400, 'validation_failed', 'Перевірте назву і скоупи', { issues: p.error.issues })
  return apiData(await createToken({ tenantId: a.tenantId, actorId: a.userId }, p.data))
})
