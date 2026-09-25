import { libraryDetachSchema } from '../../../../../../shared/schemas/library'
import { requireScope } from '../../../../../services/access'
import { libraryActorOf } from '../../../../../services/library'
import { detachUsage } from '../../../../../services/libraryUsages'
import { apiData } from '../../../../../utils/apiResponse'
import { libraryFail, libraryValidationFail } from '../../../../../utils/libraryErrors'

/**
 * POST /library/usages/:id/detach `{makeCopy}` — «Відʼєднати і зробити копією» (docs/v2/31
 * §7.10, §10). Урок курса всегда получает копию тела закреплённой версии (урок без материала не
 * бывает) — `{lessonId}`; узел трека с `makeCopy` (по умолчанию) — опубликованный материал-копию
 * `{resourceId}`, без него — пустое задание. Опубликованный трек или версия курса — `409 container.published`.
 */
export default defineEventHandler(async (event) => {
  const a = await requireScope(event, 'library.use')
  const p = libraryDetachSchema.safeParse((await readBody(event)) ?? {})
  if (!p.success) return libraryValidationFail(event, p.error)
  const r = await detachUsage(libraryActorOf(a), getRouterParam(event, 'id')!, { makeCopy: p.data.makeCopy })
  if (!r.ok) return libraryFail(event, r.code === 'not_found' ? 'usage_not_found' : r.code)
  return apiData({ lessonId: r.lessonId, resourceId: r.resourceId })
})
