import { z } from 'zod'
import { requireScope } from '../../../../services/access'
import { importFromWorkspace } from '../../../../services/googleApps'
import { providerParam } from './status.get'
import { apiData, apiError } from '../../../../utils/apiResponse'
export default defineEventHandler(async (event) => {
  const a = await requireScope(event, 'people.import')
  if (providerParam(event) !== 'google') return apiError(event, 404, 'not_found', 'Імпорт людей доступний лише з Google Workspace')
  const p = z.object({ domain: z.string().max(200).optional(), apply: z.boolean().default(false), defaultPosition: z.string().min(1), defaultOrgUnit: z.string().min(1), defaultLocation: z.string().min(1) }).safeParse(await readBody(event))
  if (!p.success) return apiError(event, 400, 'validation_failed', 'Вкажіть посаду, підрозділ і точку за замовчуванням')
  const r = await importFromWorkspace({ tenantId: a.tenantId, actorId: a.userId }, p.data)
  if (!r.ok) return apiError(event, 502, 'provider_error', r.error === 'not_connected' ? 'Google не підключено' : `Google не відповідає: ${r.error}`)
  return apiData(r)
})
