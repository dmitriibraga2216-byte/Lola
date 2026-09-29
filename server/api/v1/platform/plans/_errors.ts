import type { H3Event } from 'h3'
import type { PlanError } from '../../../../services/platformPlans'
import { apiError } from '../../../../utils/apiResponse'

/** Отказы ручек каталога тарифов (docs/24 §4.4.2, docs/04 §4.17): текст говорит оператору, что делать. */
export function planError(event: H3Event, e: PlanError) {
  switch (e.code) {
    case 'not_found': return apiError(event, 404, 'not_found', 'Тариф не знайдено')
    case 'code_taken': return apiError(event, 409, 'plan.code_taken', 'Тариф із таким кодом уже є — оберіть інший код')
    case 'unknown_addon': return apiError(event, 422, 'plan.unknown_addon', 'Такої опції немає в каталозі — оберіть опції зі списку')
    case 'default_locked': return apiError(event, 409, 'plan.default_locked', 'Пробний тариф призначається новим компаніям за замовчуванням — його не можна архівувати')
    case 'wrong_state': return apiError(event, 409, 'plan.wrong_state', 'Тариф уже в цьому стані — оновіть сторінку')
    case 'reason_required': return apiError(event, 422, 'plan.reason_required', `Тариф використовують компанії (${e.companies}) — вкажіть причину зміни, 10–500 знаків`, { companies: e.companies })
    case 'limit_unpinnable': return apiError(event, 409, 'plan.limit_unpinnable', `Ліміт «без обмежень» не можна зменшити, поки тариф використовують компанії (${e.companies}): створіть новий тариф і переведіть на нього компанії`, { companies: e.companies, fields: e.fields })
  }
}
