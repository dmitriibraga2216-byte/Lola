import { z } from 'zod'
import { CONTENT_RATING_TARGETS } from '../../../../shared/enums'
import { requireScope } from '../../../services/access'
import { unrateContent } from '../../../services/contentRatings'
import { apiData, apiError } from '../../../utils/apiResponse'

/** DELETE /content-ratings/:contentId?contentType= — забрати свою оцінку (докс/33 D-042). */
export default defineEventHandler(async (event) => {
  const a = await requireScope(event, 'learn.view')
  const q = z.object({ contentType: z.enum(CONTENT_RATING_TARGETS) }).safeParse(getQuery(event))
  if (!q.success) return apiError(event, 400, 'validation_failed', 'Вкажіть тип матеріалу')
  const r = await unrateContent({ tenantId: a.tenantId, actorId: a.userId }, { contentType: q.data.contentType, contentId: getRouterParam(event, 'contentId')! })
  return apiData(r)
})
