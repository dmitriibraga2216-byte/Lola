import { noticeUpdateSchema } from '../../../../../shared/schemas/hub'
import { can, requireScope } from '../../../../services/access'
import { updateNotice } from '../../../../services/notices'
import { apiData, apiError } from '../../../../utils/apiResponse'

export default defineEventHandler(async (event) => {
  const a = await requireScope(event, 'knowledge.manage')
  const p = noticeUpdateSchema.safeParse(await readBody(event))
  if (!p.success) return apiError(event, 400, 'validation_failed', p.error.issues[0]?.message ?? 'Перевірте оголошення', { issues: p.error.issues })
  if (p.data.blockUntilAck && !can(a, 'settings.tenant')) return apiError(event, 403, 'forbidden', 'Блокування роботи до підтвердження вмикає лише адміністратор простору') // docs/21 §7.4, Б.6
  const r = await updateNotice({ tenantId: a.tenantId, actorId: a.userId }, getRouterParam(event, 'id')!, p.data)
  if (!r) return apiError(event, 404, 'not_found', 'Оголошення не знайдено')
  return apiData(r)
})
