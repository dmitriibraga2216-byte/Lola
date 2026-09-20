import { z } from 'zod'
import { CONTENT_TYPES } from '../../../../shared/enums'
import { requireScope } from '../../../services/access'
import { contentUsages } from '../../../services/trajectories'
import { apiData, apiError } from '../../../utils/apiResponse'
/** Где используется контент: траектории с блоком «Завдання» на него. */
export default defineEventHandler(async (event) => {
  const a = await requireScope(event, 'program.manage')
  const q = z.object({ contentType: z.enum(CONTENT_TYPES), contentId: z.string().uuid() }).safeParse(getQuery(event))
  if (!q.success) return apiError(event, 400, 'validation_failed', 'Вкажіть contentType і contentId')
  return apiData(await contentUsages({ tenantId: a.tenantId, actorId: a.userId }, q.data.contentType, q.data.contentId))
})
