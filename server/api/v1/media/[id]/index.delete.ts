import { deleteMediaSchema } from '../../../../../shared/schemas/content'
import { requireScope } from '../../../../services/access'
import { softDeleteMedia } from '../../../../services/media'
import { apiData, apiError } from '../../../../utils/apiResponse'

/**
 * `DELETE /media/:id` — мягкое удаление, **единственная** одиночная ручка удаления файла
 * (docs/04 §4.15, решение docs/v2/44 В-17; `DELETE /storage/files/:id` из `34` §10 отменён
 * как второе имя того же, массовое удаление — только заявкой `POST /storage/deletions`).
 *
 * Скоуп — `storage.delete`, а не `storage.manage`: «посмотреть хранилище» и «снести
 * доказательство» — разные права, объединять их в один скоуп нельзя (`34` §2 против
 * `35` §2, коллизия `41` §8.1).
 *
 * Чужой тенант — 404, не 403 (CLAUDE.md п. 15): `softDeleteMedia` не находит строку
 * под RLS и возвращает `not_found`.
 */
export default defineEventHandler(async (event) => {
  const access = await requireScope(event, 'storage.delete')
  const parsed = deleteMediaSchema.safeParse(await readBody(event).catch(() => ({})) ?? {})
  if (!parsed.success) return apiError(event, 400, 'validation_failed', 'Перевірте причину видалення')

  const result = await softDeleteMedia(
    { tenantId: access.tenantId, actorId: access.userId },
    getRouterParam(event, 'id')!,
    parsed.data,
  )
  if (!result.ok) {
    if (result.code === 'not_found') return apiError(event, 404, 'not_found', 'Файл не знайдено')
    if (result.code === 'file_not_deletable') return apiError(event, 403, 'file_not_deletable', result.message)
    if (result.code === 'already_deleted') return apiError(event, 409, 'already_deleted', result.message)
    // docs/v2/31 §7.13, §12: «409 со списком версий» — чтобы было понятно, какие модули его держат
    if (result.code === 'in_library_version') return apiError(event, 409, 'media.in_library_version', result.message, { versions: result.versions })
    if (result.code === 'under_review') return apiError(event, 409, 'under_review', result.message)
    return apiError(event, 409, 'evidence_locked', result.message)
  }
  return apiData({ lifecycle: result.lifecycle, purgeAfter: result.purgeAfter })
})
