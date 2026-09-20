import { noticeSchema } from '../../../../shared/schemas/hub'
import { can, requireScope } from '../../../services/access'
import { createNotice } from '../../../services/notices'
import { apiData, apiError } from '../../../utils/apiResponse'

/** POST /notices — объявление; аудитория и срок задаются назначением (POST /tasks, subjectType=notice). */
export default defineEventHandler(async (event) => {
  const a = await requireScope(event, 'knowledge.manage')
  const p = noticeSchema.safeParse(await readBody(event))
  if (!p.success) return apiError(event, 400, 'validation_failed', p.error.issues[0]?.message ?? 'Перевірте оголошення', { issues: p.error.issues })
  if (p.data.blockUntilAck && !can(a, 'settings.tenant')) return apiError(event, 403, 'forbidden', 'Блокування роботи до підтвердження вмикає лише адміністратор простору') // docs/21 §7.4, Б.6
  return apiData(await createNotice({ tenantId: a.tenantId, actorId: a.userId }, p.data))
})
