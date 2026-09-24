import { libraryPublishVersionSchema } from '../../../../../../../shared/schemas/library'
import { requireAnyScope } from '../../../../../../services/access'
import { libraryActorOf, publishVersion } from '../../../../../../services/library'
import { apiData, apiError } from '../../../../../../utils/apiResponse'
import { libraryFail, libraryValidationFail } from '../../../../../../utils/libraryErrors'

/**
 * POST /library/modules/:id/versions `{changelog, isHotfix, notify, expectedVersion?}` —
 * «Опублікувати версію» (docs/v2/31 §6.2, §7.9, §10). Места на прежних версиях не
 * переключаются — только помечаются устаревшими (критерий приёмки 1).
 */
export default defineEventHandler(async (event) => {
  const a = await requireAnyScope(event, ['library.publish', 'library.manage'])
  const p = libraryPublishVersionSchema.safeParse((await readBody(event)) ?? {})
  if (!p.success) return libraryValidationFail(event, p.error, 'Опишіть зміни — це побачать автори треків')
  const r = await publishVersion(libraryActorOf(a), getRouterParam(event, 'id')!, p.data)
  if (r.ok) return apiData(r)
  if (r.code === 'version_conflict') {
    // §12: второй из двух одновременно публикующих авторов получает понятный отказ, а не v5
    return apiError(event, 409, 'version_conflict', r.current ? `Версію v${r.current} вже опубліковано. Оновіть сторінку` : 'Версію вже оновлено. Оновіть сторінку', { current: r.current })
  }
  return libraryFail(event, r.code, r.code === 'forbidden' ? { reason: 'not_author' } : undefined)
})
