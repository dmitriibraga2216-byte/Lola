import { z } from 'zod'
import { requireScope } from '../../../../services/access'
import { setReporterMute, viewerOf } from '../../../../services/contentIssueTriage'
import { apiData, apiError } from '../../../../utils/apiResponse'

/** POST /content-reporters/:userId/unmute — снять приостановку; снимает её администратор (§7.11). */
export default defineEventHandler(async (event) => {
  const a = await requireScope(event, 'content_issue.mute')
  const userId = z.string().uuid().safeParse(getRouterParam(event, 'userId'))
  if (!userId.success) return apiError(event, 404, 'not_found', 'Людину не знайдено')
  const r = await setReporterMute(await viewerOf(a), userId.data, null)
  if (!r.ok) return apiError(event, 404, 'not_found', 'Людину не знайдено')
  return apiData({ ok: true })
})
