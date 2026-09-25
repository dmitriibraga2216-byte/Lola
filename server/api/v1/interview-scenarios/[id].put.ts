import { requireScope } from '../../../services/access'
import { updateScenario } from '../../../services/interview/scenarios'
import { interviewScenarioUpdateSchema } from '../../../../shared/schemas/interview'
import { apiData } from '../../../utils/apiResponse'
import { interviewValidationFail, scenarioFail } from '../../../utils/interviewErrors'

/**
 * PUT /interview-scenarios/:id — правка и смена статуса (`docs/v2/30` §6.1, §7.5, §10;
 * `interview.configure`). `status: 'published'` без альтернативы — `422
 * scenario.alternative_required`, статус остаётся `draft` (`30` §13 к. 3); без критериев —
 * `422 criteria.required`. Правка опубликованного создаёт новую версию-черновик
 * (`versionCreated: true`) — идущие сессии держат свою версию (`30` §12 п. 9).
 */
export default defineEventHandler(async (event) => {
  const a = await requireScope(event, 'interview.configure')
  const p = interviewScenarioUpdateSchema.safeParse(await readBody(event))
  if (!p.success) return interviewValidationFail(event, p.error)
  const r = await updateScenario({ tenantId: a.tenantId, actorId: a.userId }, getRouterParam(event, 'id')!, p.data)
  if (!r.ok) return scenarioFail(event, r.code, r.draftId ? { draftId: r.draftId } : undefined)
  return apiData({ ...r.scenario, versionCreated: r.versionCreated ?? false })
})
