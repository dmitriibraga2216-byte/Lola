import { libraryUpdateVersionSchema } from '../../../../../../shared/schemas/library'
import { requireScope } from '../../../../../services/access'
import { libraryActorOf } from '../../../../../services/library'
import { updateUsageVersion } from '../../../../../services/libraryUsages'
import { apiData } from '../../../../../utils/apiResponse'
import { libraryFail, libraryValidationFail } from '../../../../../utils/libraryErrors'

/**
 * POST /library/usages/:id/update-version `{toVersion?}` — «Оновити до останньої версії»
 * (docs/v2/31 §5.5, §7.3, §10). Без `toVersion` — последняя опубликованная. Право на контейнер —
 * `course.edit` для курса, `program.manage` для трека (`403 container.forbidden`); уже на этой
 * версии — `409 already_latest`; назад — `422 version_downgrade` (отката нет, §12); выведенная
 * из оборота — `422 version_retired`; урок опубликованной версии курса — `409 container.published`.
 */
export default defineEventHandler(async (event) => {
  const a = await requireScope(event, 'library.use')
  const p = libraryUpdateVersionSchema.safeParse((await readBody(event)) ?? {})
  if (!p.success) return libraryValidationFail(event, p.error)
  const r = await updateUsageVersion(libraryActorOf(a), getRouterParam(event, 'id')!, p.data)
  if (!r.ok) return libraryFail(event, r.code === 'not_found' ? 'usage_not_found' : r.code)
  return apiData({ ...r.usage, updatedFrom: r.updatedFrom, updatedTo: r.updatedTo })
})
