import { aiProviderCreateSchema } from '../../../../../shared/schemas/ai'
import { requireScope } from '../../../../services/access'
import { createProvider } from '../../../../services/ai/providers'
import { apiData } from '../../../../utils/apiResponse'
import { providerFail, providerValidationFail } from '../../../../utils/aiErrors'

/**
 * POST /ai/providers — новый профиль (`docs/v2/30` §3.2, §10). `30` §10 сворачивает ручки в
 * `GET | PUT /ai/providers[/:id]`, `41` §8.4 — в `GET/POST` и отмечает, что свёртка не
 * разворачивается однозначно. Развёрнуто так: список и профиль — `GET`, правка — `PUT /:id`,
 * создание — `POST`: запасному профилю цепочки (`30` §7.12) нужна вторая строка той же роли, а
 * профили платформы по одному на роль (`[решение]` PR-27).
 *
 * `422 provider.retention_unknown` — профиль расшифровки с неизвестным сроком хранения у
 * поставщика (сквозная проверка 18 `42` §5).
 */
export default defineEventHandler(async (event) => {
  const a = await requireScope(event, 'ai.audit')
  const p = aiProviderCreateSchema.safeParse(await readBody(event))
  if (!p.success) return providerValidationFail(event, p.error)
  const r = await createProvider({ tenantId: a.tenantId, actorId: a.userId }, p.data)
  if (!r.ok) return providerFail(event, r.code)
  setResponseStatus(event, 201)
  return apiData(r.provider)
})
