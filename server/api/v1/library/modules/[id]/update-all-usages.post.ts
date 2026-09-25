import { libraryUpdateVersionSchema } from '../../../../../../shared/schemas/library'
import { requireScope } from '../../../../../services/access'
import { libraryActorOf } from '../../../../../services/library'
import { updateAllUsages } from '../../../../../services/libraryUsages'
import { apiData } from '../../../../../utils/apiResponse'
import { libraryFail, libraryValidationFail } from '../../../../../utils/libraryErrors'

/**
 * POST /library/modules/:id/update-all-usages `{toVersion?}` — «Оновити все до v4» (docs/v2/31
 * §5.3, §10), только `library.manage` (§2). Ответ `{updated, skipped[], toVersion}`: пропуск —
 * место, которое обновить нельзя (урок опубликованной версии курса, исчезнувший держатель).
 */
export default defineEventHandler(async (event) => {
  const a = await requireScope(event, 'library.manage')
  const p = libraryUpdateVersionSchema.safeParse((await readBody(event)) ?? {})
  if (!p.success) return libraryValidationFail(event, p.error)
  const r = await updateAllUsages(libraryActorOf(a), getRouterParam(event, 'id')!, p.data)
  if (!r.ok) return libraryFail(event, r.code)
  return apiData({ updated: r.updated, skipped: r.skipped, toVersion: r.toVersion })
})
