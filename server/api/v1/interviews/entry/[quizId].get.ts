import { requireAccess } from '../../../../services/access'
import { getEntry } from '../../../../services/interview/candidate'
import { interviewEntryQuerySchema } from '../../../../../shared/schemas/interview'
import { apiData } from '../../../../utils/apiResponse'
import { interviewFail, interviewValidationFail } from '../../../../utils/interviewErrors'

/**
 * GET /interviews/entry/:quizId — вход кандидата в модуль собеседования (`docs/v2/30` §4, §5.1):
 * текст согласия на его языке с редакцией и хешем, действующий сценарий и что показать дальше —
 * согласие, продолжение, альтернативу. Попытки при этом не создаётся (`30` §13 к. 1). Прав не
 * нужно (`41` §2.3): тест должен быть назначен именно этому человеку, иначе — `404`.
 */
export default defineEventHandler(async (event) => {
  const a = await requireAccess(event)
  const q = interviewEntryQuerySchema.safeParse(getQuery(event))
  if (!q.success) return interviewValidationFail(event, q.error)
  const r = await getEntry({ tenantId: a.tenantId, actorId: a.userId }, getRouterParam(event, 'quizId')!, q.data)
  return r.ok ? apiData(r.state) : interviewFail(event, r.code)
})
