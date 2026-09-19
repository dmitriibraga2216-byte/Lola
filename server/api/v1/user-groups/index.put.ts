import { groupSchema } from '../../../../shared/schemas/people'
import { requireScope } from '../../../services/access'
import { upsertGroup } from '../../../services/groups'
import { apiData, apiError } from '../../../utils/apiResponse'

/** Групи та сегменти (docs/16 §3.4). */
export default defineEventHandler(async (event) => {
  const access = await requireScope(event, 'people.edit')
  const parsed = groupSchema.safeParse(await readBody(event))
  if (!parsed.success) return apiError(event, 400, 'validation_failed', 'Перевірте поля', { issues: parsed.error.issues })
  const g = await upsertGroup({ tenantId: access.tenantId, actorId: access.userId }, parsed.data)
  if (!g) return apiError(event, 404, 'not_found', 'Групу не знайдено')
  return apiData(g)
})
