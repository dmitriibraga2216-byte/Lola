import { guestBlocksSchema } from '../../../../shared/schemas/hub'
import { requireScope } from '../../../services/access'
import { setGuestBlocks } from '../../../services/hubExtra'
import { apiData, apiError } from '../../../utils/apiResponse'

export default defineEventHandler(async (event) => {
  const a = await requireScope(event, 'settings.tenant')
  const p = guestBlocksSchema.safeParse(await readBody(event))
  if (!p.success) return apiError(event, 400, 'validation_failed', p.error.issues[0]?.message ?? 'Перевірте гостьову сторінку', { issues: p.error.issues })
  return apiData(await setGuestBlocks({ tenantId: a.tenantId, actorId: a.userId }, p.data))
})
