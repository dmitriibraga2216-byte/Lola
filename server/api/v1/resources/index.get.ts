import { resourceListQuerySchema } from '../../../../shared/schemas/resources'
import { requireScope } from '../../../services/access'
import { listResources } from '../../../services/resources'
import { apiData, apiError } from '../../../utils/apiResponse'

/** GET /resources — библиотека ресурсов (docs/11 §5.1, §10): вкладки по статусу, фильтры тип/автор/метка/категория/поиск. */
export default defineEventHandler(async (event) => {
  const a = await requireScope(event, 'course.view')
  const p = resourceListQuerySchema.safeParse(getQuery(event))
  if (!p.success) return apiError(event, 400, 'validation_failed', 'Перевірте фільтри', { issues: p.error.issues })
  return apiData(await listResources({ tenantId: a.tenantId, actorId: a.userId }, p.data))
})
