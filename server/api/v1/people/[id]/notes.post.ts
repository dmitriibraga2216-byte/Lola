import { noteSchema } from '../../../../../shared/schemas/people'
import { requireScope } from '../../../../services/access'
import { addNote } from '../../../../services/people'
import { apiData, apiError } from '../../../../utils/apiResponse'

export default defineEventHandler(async (event) => {
  const access = await requireScope(event, 'people.edit')
  const parsed = noteSchema.safeParse(await readBody(event))
  if (!parsed.success) return apiError(event, 400, 'validation_failed', 'Порожня нотатка', { issues: parsed.error.issues })
  return apiData(await addNote({ tenantId: access.tenantId, actorId: access.userId }, getRouterParam(event, 'id')!, parsed.data.body))
})
