import { tenantPatchSchema } from '../../../../shared/schemas/settings'
import { requireScope } from '../../../services/access'
import { updateTenantSpace } from '../../../services/settings'
import { apiData, apiError } from '../../../utils/apiResponse'
/** PATCH /settings/tenant: slug по правилам docs/24 §6 и docs/29 Б.12 (после первого входа сотрудника не меняется), акцент — только из палитры (Б.14). */
export default defineEventHandler(async (event) => {
  const a = await requireScope(event, 'settings.tenant')
  const p = tenantPatchSchema.safeParse(await readBody(event))
  if (!p.success) {
    const field = p.error.issues[0]?.path[0]
    const msg = field === 'slug' ? 'Адреса зайнята або містить недопустимі символи' : field === 'accent' ? 'Колір має відповідати бренд-буку' : field === 'quietHours' ? 'Вікно має бути не меншим за 4 години' : 'Перевірте поля'
    return apiError(event, 400, 'validation_failed', msg, { issues: p.error.issues })
  }
  const r = await updateTenantSpace({ tenantId: a.tenantId, actorId: a.userId }, p.data)
  if (!r.ok) {
    if (r.code === 'slug_taken') return apiError(event, 409, 'slug_taken', 'Адреса зайнята або містить недопустимі символи')
    return apiError(event, 409, 'slug_locked', 'Адресу простору не можна змінити після першого входу співробітника — старі посилання перестануть працювати')
  }
  return apiData(r.space)
})
