import { simpleNoticeSchema } from '../../../../shared/schemas/hub'
import { requireScope } from '../../../services/access'
import { createSimpleNotice } from '../../../services/notices'
import { apiData, apiError } from '../../../utils/apiResponse'

export default defineEventHandler(async (event) => {
  const a = await requireScope(event, 'knowledge.manage')
  const p = simpleNoticeSchema.safeParse(await readBody(event))
  if (!p.success) return apiError(event, 400, 'validation_failed', p.error.issues[0]?.message ?? 'Перевірте оголошення', { issues: p.error.issues })
  return apiData(await createSimpleNotice({ tenantId: a.tenantId, actorId: a.userId }, p.data))
})
