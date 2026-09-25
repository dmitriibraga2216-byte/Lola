import { candidateSummaryRevokeSchema } from '../../../../../shared/schemas/candidateSummaries'
import { requireScope } from '../../../../services/access'
import { viewerOf } from '../../../../services/candidates'
import { revokeSummary } from '../../../../services/candidateSummaries'
import { apiError } from '../../../../utils/apiResponse'

/** POST /candidate-summaries/:id/revoke — «Відкликати доступ» (`docs/v2/30` §4, §10; `summary.send`): `204`. */
export default defineEventHandler(async (event) => {
  const a = await requireScope(event, 'summary.send')
  const p = candidateSummaryRevokeSchema.safeParse(await readBody(event))
  if (!p.success) return apiError(event, 422, 'validation_failed', p.error.issues[0]?.message ?? 'Вкажіть причину', { issues: p.error.issues })
  const r = await revokeSummary(viewerOf(a), getRouterParam(event, 'id')!, p.data.reason)
  if (r.ok) {
    setResponseStatus(event, 204)
    return null
  }
  if (r.code === 'not_revocable') return apiError(event, 409, 'summary.not_revocable', 'Відкликати можна лише готовий або надісланий підсумок')
  return apiError(event, 404, 'not_found', 'Підсумок не знайдено')
})
