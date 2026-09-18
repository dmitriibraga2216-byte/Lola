import { moduleCreateSchema } from '../../../../../shared/schemas/content'
import { requireScope } from '../../../../services/access'
import { addModule } from '../../../../services/courses'
import { apiData, apiError } from '../../../../utils/apiResponse'

export default defineEventHandler(async (event) => {
  const access = await requireScope(event, 'course.edit')
  const parsed = moduleCreateSchema.safeParse(await readBody(event))
  if (!parsed.success) return apiError(event, 400, 'validation_failed', 'Вкажіть назву розділу')
  const mod = await addModule(
    { tenantId: access.tenantId, actorId: access.userId },
    getRouterParam(event, 'id')!,
    parsed.data.title,
  )
  if (!mod) return apiError(event, 404, 'not_found', 'Курс не знайдено')
  return apiData(mod)
})
