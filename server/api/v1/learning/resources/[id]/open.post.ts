import { resourcePassOpenSchema } from '../../../../../../shared/schemas/resources'
import { requireScope } from '../../../../../services/access'
import { openResourcePass } from '../../../../../services/resourcePass'
import { apiData, apiError } from '../../../../../utils/apiResponse'

/**
 * Открыть ресурс как задание (docs/11 Г-11.5): тело закреплённой версии, факты прохождения и
 * готовность по правилу типа. `assignmentId` — назначение, по которому человек проходит материал
 * (узел траектории, прямое); без него — элемент программы. Чужое назначение и чужой тенант — 404.
 */
export default defineEventHandler(async (event) => {
  const a = await requireScope(event, 'learn.view')
  const p = resourcePassOpenSchema.safeParse((await readBody(event).catch(() => ({}))) ?? {})
  if (!p.success) return apiError(event, 400, 'validation_failed', 'Некоректне призначення')
  const r = await openResourcePass({ tenantId: a.tenantId, actorId: a.userId }, getRouterParam(event, 'id')!, p.data)
  if (!r.ok) return apiError(event, 404, 'not_found', 'Матеріал не знайдено або він вам не призначений')
  return apiData(r)
})
