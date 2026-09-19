import { requireScope } from '../../../../services/access'
import { ackNews } from '../../../../services/news'
import { apiData, apiError } from '../../../../utils/apiResponse'
/** «Ознайомився»: засчитывается после 10 с на странице и прокрутки до кнопки (docs/21 §7.3). */
export default defineEventHandler(async (event) => {
  const a = await requireScope(event, 'learn.view')
  const r = await ackNews({ tenantId: a.tenantId, actorId: a.userId }, getRouterParam(event, 'id')!)
  if (!r.ok) return apiError(event, r.code === 'not_found' ? 404 : 422, `news.${r.code}`, r.code === 'too_fast' ? 'Прочитайте уважно — підтвердити можна за 10 секунд' : r.code === 'not_scrolled' ? 'Догортайте до кінця' : 'Новину не знайдено')
  return apiData(r)
})
