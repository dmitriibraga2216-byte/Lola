import { requireAccess } from '../../../../../services/access'
import { startTextForm } from '../../../../../services/interview/candidate'
import { interviewEntryQuerySchema } from '../../../../../../shared/schemas/interview'
import { apiData } from '../../../../../utils/apiResponse'
import { interviewFail, interviewValidationFail } from '../../../../../utils/interviewErrors'

/**
 * POST /interviews/entry/:quizId/text-form — письменная форма, альтернатива `text_form`
 * (`docs/v2/30` §6.3, §7.5): те же вопросы обычной попыткой без записи и без ИИ, ручная проверка.
 * Открывается после отказа от ИИ, при недоступном ИИ или без микрофона при сценарии без текста.
 */
export default defineEventHandler(async (event) => {
  const a = await requireAccess(event)
  const p = interviewEntryQuerySchema.safeParse((await readBody(event).catch(() => ({}))) ?? {})
  if (!p.success) return interviewValidationFail(event, p.error)
  const r = await startTextForm({ tenantId: a.tenantId, actorId: a.userId }, getRouterParam(event, 'quizId')!, p.data)
  return r.ok ? apiData(r) : interviewFail(event, r.code)
})
