import { publicForm } from '../../../../../services/mystery'
import { apiData, apiError } from '../../../../../utils/apiResponse'
/** Форма тайного покупателя по одноразовой ссылке — без входа (docs/20 §7.8, Б.2). */
export default defineEventHandler(async (event) => {
  const r = await publicForm(getRouterParam(event, 'token')!)
  if (!r.ok) return apiError(event, r.code === 'not_found' ? 404 : 410, `mystery.${r.code}`, r.code === 'used' ? 'Це посилання вже використано' : r.code === 'expired' ? 'Посилання застаріло — попросіть нове' : 'Посилання не знайдено')
  return apiData(r.form)
})
