import { aiProviderUpdateSchema } from '../../../../../shared/schemas/ai'
import { requireScope } from '../../../../services/access'
import { updateProvider } from '../../../../services/ai/providers'
import { apiData } from '../../../../utils/apiResponse'
import { providerFail, providerValidationFail } from '../../../../utils/aiErrors'

/**
 * PUT /ai/providers/:id — правка профиля (`docs/v2/30` §3.2, §10; `41` §2: «`provider_retention =
 * 'unknown'` не допускается»). Переданные поля меняются, остальные остаются. `apiKey: null`
 * снимает свой ключ тенанта. Регион `other` — только с `regionComment`, он уходит в `audit_log`.
 */
export default defineEventHandler(async (event) => {
  const a = await requireScope(event, 'ai.audit')
  const p = aiProviderUpdateSchema.safeParse(await readBody(event))
  if (!p.success) return providerValidationFail(event, p.error)
  const r = await updateProvider({ tenantId: a.tenantId, actorId: a.userId }, getRouterParam(event, 'id')!, p.data)
  return r.ok ? apiData(r.provider) : providerFail(event, r.code)
})
