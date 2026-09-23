import type { H3Event } from 'h3'
import type { RoleError } from '../../../../services/roles'
import { apiError } from '../../../../utils/apiResponse'

/** Коды ошибок редактора ролей с объяснением, что делать (docs/24 §3.5, §11). */
export function roleError(event: H3Event, code: RoleError, details?: Record<string, unknown>) {
  switch (code) {
    case 'not_found': return apiError(event, 404, 'not_found', 'Роль не знайдено')
    case 'code_taken': return apiError(event, 409, 'code_taken', 'Роль з таким кодом уже є — оберіть інший код')
    case 'system_role': return apiError(event, 409, 'system_role', 'Системну роль не можна видалити')
    case 'admin_role': return apiError(event, 409, 'admin_role', 'Набір прав адміністратора змінювати не можна — інакше простір заблокує сам себе')
    case 'owner_role': return apiError(event, 409, 'owner_role', 'Набір прав власника змінювати не можна — володіння передають, а не переписують')
    case 'role_in_use': return apiError(event, 409, 'role_in_use', 'Роль видана людям — спочатку перепризначте їх', details)
    case 'last_settings_role': return apiError(event, 409, 'last_settings_role', 'Це остання роль з правом «Налаштування простору» — його не можна зняти')
    case 'scope_not_owned': return apiError(event, 403, 'scope_not_owned', 'Не можна видати права, яких немає у вас самих', details)
  }
}
