import { chiefSchema } from '../../../../shared/schemas/people'
import { requireScope } from '../../../services/access'
import { setChief } from '../../../services/people'
import { apiData, apiError } from '../../../utils/apiResponse'

export default defineEventHandler(async (event) => {
  const access = await requireScope(event, 'people.edit')
  const parsed = chiefSchema.safeParse(await readBody(event))
  if (!parsed.success) return apiError(event, 400, 'validation_failed', 'Перевірте поля', { issues: parsed.error.issues })
  const r = await setChief({ tenantId: access.tenantId, actorId: access.userId }, parsed.data)
  if (!r) return apiError(event, 400, 'self', 'Людина не може бути керівником собі')
  return apiData(r)
})
