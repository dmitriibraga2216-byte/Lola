import { resourcePassRefSchema } from '../../../../../../shared/schemas/resources'
import { requireScope } from '../../../../../services/access'
import { downloadResourcePass } from '../../../../../services/resourcePass'
import { apiData, apiError } from '../../../../../utils/apiResponse'

/** Документ скачан (Г-11.5: «пролистан до конца либо скачан»). */
export default defineEventHandler(async (event) => {
  const a = await requireScope(event, 'learn.view')
  const p = resourcePassRefSchema.safeParse((await readBody(event).catch(() => ({}))) ?? {})
  if (!p.success) return apiError(event, 400, 'validation_failed', 'Некоректне призначення')
  const r = await downloadResourcePass({ tenantId: a.tenantId, actorId: a.userId }, getRouterParam(event, 'id')!, p.data)
  if (!r) return apiError(event, 404, 'not_found', 'Матеріал не відкрито — відкрийте його ще раз')
  return apiData(r)
})
