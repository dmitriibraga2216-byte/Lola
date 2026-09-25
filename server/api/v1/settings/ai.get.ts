import { requireScope } from '../../../services/access'
import { aiSettings } from '../../../services/settings'
import { apiData } from '../../../utils/apiResponse'

/** GET /settings/ai — переключатели функций ИИ тенанта (`docs/v2/30` §5.6; `ai.audit`). */
export default defineEventHandler(async (event) => {
  const a = await requireScope(event, 'ai.audit')
  return apiData(await aiSettings({ tenantId: a.tenantId, actorId: a.userId }))
})
