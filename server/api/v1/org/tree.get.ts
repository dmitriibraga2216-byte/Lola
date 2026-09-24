import { requireScope } from '../../../services/access'
import { orgTree } from '../../../services/orgTree'
import { apiData } from '../../../utils/apiResponse'

/**
 * GET /org/tree — справочник подразделений, точек и людей на них для экранов администрирования
 * (фильтры, форма человека, счётчики на `/admin/org`). **Не витрина:** публичная оргструктура
 * хаба заменена витриной дерева подчинения `GET /org-structure/tree?mode=view` (docs/v2/39 П-21,
 * docs/v2/32 §5.2), поэтому ручка больше не открыта каждому сотруднику (`learn.view`) — только
 * тем, кто и так видит справочник людей (`people.view`).
 */
export default defineEventHandler(async (event) => {
  const a = await requireScope(event, 'people.view')
  return apiData(await orgTree({ tenantId: a.tenantId, actorId: a.userId }))
})
