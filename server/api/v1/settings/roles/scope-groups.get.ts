import { requireScope } from '../../../../services/access'
import { SCOPE_GROUPS } from '../../../../services/roles'
import { apiData } from '../../../../utils/apiResponse'

/**
 * GET /settings/roles/scope-groups (docs/24 §3.5, docs/01 §1.3): группы прав для редактора ролей —
 * какие чекбоксы и в каком порядке показывать.
 *
 * Отдельная ручка, а не поле в ответе `GET /settings/roles`: тот отдаёт **массив** ролей, а
 * дописанное к массиву свойство (`Object.assign(roles, { groups })`) при сериализации в JSON
 * теряется — у массива сохраняются только индексы. Редактор из-за этого падал на `groups.map`
 * при первом же клике по роли. Менять форму ответа `/settings/roles` нельзя: его массив читают
 * шесть экранов (люди, назначения, карточка человека, «Посада → роль», политики).
 */
export default defineEventHandler(async (event) => {
  await requireScope(event, 'people.view')
  return apiData(SCOPE_GROUPS)
})
