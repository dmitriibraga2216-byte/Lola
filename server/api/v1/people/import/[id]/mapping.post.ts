import { importMappingSchema } from '../../../../../../shared/schemas/people'
import { requireScope } from '../../../../../services/access'
import { remapImport } from '../../../../../services/importPeople'
import { apiData, apiError } from '../../../../../utils/apiResponse'

/** Зіставлення колонок і опції (docs/16 §5.4 кроки 2, 4): повторна валідація тих самих рядків. */
export default defineEventHandler(async (event) => {
  const access = await requireScope(event, 'people.import')
  const parsed = importMappingSchema.safeParse(await readBody(event))
  if (!parsed.success) return apiError(event, 400, 'validation_failed', 'Перевірте зіставлення', { issues: parsed.error.issues })
  const result = await remapImport({ tenantId: access.tenantId, actorId: access.userId }, getRouterParam(event, 'id')!, parsed.data)
  if (!result) return apiError(event, 409, 'conflict', 'Імпорт уже застосовано або не знайдено')
  return apiData(result)
})
