import { z } from 'zod'
import { requireScope } from '../../../../../services/access'
import { restoreFile } from '../../../../../services/storage'
import { apiData, apiError } from '../../../../../utils/apiResponse'

/**
 * `POST /storage/files/:id/restore` (docs/v2/34 §4, §10): вернуть файл из корзины в один клик.
 * Квоту не проверяет — восстановление разрешено сверх лимита (§12). Чужой тенант — 404.
 */
export default defineEventHandler(async (event) => {
  const a = await requireScope(event, 'storage.delete')
  const id = z.string().uuid().safeParse(getRouterParam(event, 'id'))
  if (!id.success) return apiError(event, 404, 'not_found', 'Файл не знайдено')
  const r = await restoreFile({ tenantId: a.tenantId, actorId: a.userId }, id.data)
  if (!r.ok) {
    if (r.code === 'already_purged') return apiError(event, 409, 'already_purged', 'Файл уже остаточно видалено — відновити не вийде')
    if (r.code === 'not_deleted') return apiError(event, 409, 'not_deleted', 'Файл не в кошику')
    if (r.code === 'not_restorable') return apiError(event, 409, 'storage.not_restorable', 'Запис відповіді співбесіди не відновлюється: його видалено за згодою кандидата або строком зберігання')
    return apiError(event, 404, 'not_found', 'Файл не знайдено')
  }
  return apiData(r)
})
