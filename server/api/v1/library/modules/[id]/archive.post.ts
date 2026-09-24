import { libraryArchiveSchema } from '../../../../../../shared/schemas/library'
import { requireAnyScope } from '../../../../../services/access'
import { archiveModule, libraryActorOf } from '../../../../../services/library'
import { apiData } from '../../../../../utils/apiResponse'
import { libraryFail, libraryValidationFail } from '../../../../../utils/libraryErrors'

/**
 * POST /library/modules/:id/archive `{reason}` (docs/v2/31 §4, §6.3, §7.6, §10). Без причины —
 * `422 reason_required`. Модуль уходит из палитры и списка по умолчанию; вставленные места
 * работают на своих версиях дальше (критерий приёмки 4).
 */
export default defineEventHandler(async (event) => {
  const a = await requireAnyScope(event, ['library.publish', 'library.manage'])
  const p = libraryArchiveSchema.safeParse((await readBody(event)) ?? {})
  if (!p.success) return libraryValidationFail(event, p.error, 'Вкажіть причину — вона буде видна авторам треків')
  const r = await archiveModule(libraryActorOf(a), getRouterParam(event, 'id')!, p.data.reason)
  if (!r.ok) return libraryFail(event, r.code, r.code === 'forbidden' ? { reason: 'not_author' } : undefined)
  return apiData({ ...r.module, notified: r.notified })
})
