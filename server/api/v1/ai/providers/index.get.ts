import { requireScope } from '../../../../services/access'
import { listProviders } from '../../../../services/ai/providers'
import { apiData } from '../../../../utils/apiResponse'

/**
 * GET /ai/providers — профили поставщика модели тенанта (`docs/v2/30` §3.2, §5.6, §10; `41` §2).
 * Скоуп `ai.audit`. Ключа в ответе нет — только `hasOwnKey`. Тенант, заведённый до PR-27,
 * получает профили-заглушки платформы при первом открытии списка.
 */
export default defineEventHandler(async (event) => {
  const a = await requireScope(event, 'ai.audit')
  return apiData({ items: await listProviders({ tenantId: a.tenantId, actorId: a.userId }) })
})
