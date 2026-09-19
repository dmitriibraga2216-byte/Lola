import { requireScope } from '../../../../../services/access'
import { selfEnrollProgram } from '../../../../../services/programs'
import { apiData, apiError } from '../../../../../utils/apiResponse'
/** Самозапись из каталога (docs/17 §3.4); :id — программа. */
export default defineEventHandler(async (event) => {
  const a = await requireScope(event, 'learn.catalog')
  const r = await selfEnrollProgram({ tenantId: a.tenantId, actorId: a.userId }, getRouterParam(event, 'id')!)
  if (!r.ok) {
    if (r.code === 'requested') return apiData({ requested: true })
    return apiError(event, r.code === 'not_found' ? 404 : 409, `program.${r.code}`, r.code === 'finished_no_reassign' ? 'Програму вже завершено, повторне призначення вимкнено' : r.code === 'not_in_catalog' ? 'Програма не доступна через каталог' : 'Програму не знайдено')
  }
  return apiData(r)
})
