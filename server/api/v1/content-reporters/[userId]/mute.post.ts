import { z } from 'zod'
import { requireScope } from '../../../../services/access'
import { setReporterMute, viewerOf } from '../../../../services/contentIssueTriage'
import { apiData, apiError } from '../../../../utils/apiResponse'
import { reporterMuteSchema } from '../../../../../shared/schemas/contentIssues'

/** POST /content-reporters/:userId/mute — приостановить приём жалоб от человека (docs/v2/36 §7.11). */
export default defineEventHandler(async (event) => {
  const a = await requireScope(event, 'content_issue.mute')
  const userId = z.string().uuid().safeParse(getRouterParam(event, 'userId'))
  if (!userId.success) return apiError(event, 404, 'not_found', 'Людину не знайдено')
  const p = reporterMuteSchema.safeParse(await readBody(event))
  if (!p.success) return apiError(event, 400, 'validation_failed', 'Вкажіть дату й причину')
  const r = await setReporterMute(await viewerOf(a), userId.data, p.data)
  if (!r.ok) return apiError(event, 404, 'not_found', 'Людину не знайдено')
  return apiData({ ok: true })
})
