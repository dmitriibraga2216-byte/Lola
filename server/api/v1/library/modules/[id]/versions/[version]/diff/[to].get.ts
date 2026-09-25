import { requireScope } from '../../../../../../../../services/access'
import { compareVersions, libraryActorOf } from '../../../../../../../../services/library'
import { apiData } from '../../../../../../../../utils/apiResponse'
import { libraryFail } from '../../../../../../../../utils/libraryErrors'

/**
 * GET /library/modules/:id/versions/:from/diff/:to — поблочный diff двух версий по `block.id`
 * (docs/v2/31 §3.3, §5.2 «Порівняти з v3», §10): `{added[], removed[], changed[]}` плюс тела
 * обеих версий («було / стало») и changelog версий между ними. Параметр `:from` назван
 * `version`, как у соседнего `versions/[version].get.ts`: у одного сегмента маршрута — одно имя.
 */
export default defineEventHandler(async (event) => {
  const a = await requireScope(event, 'library.view')
  const from = Number(getRouterParam(event, 'version'))
  const to = Number(getRouterParam(event, 'to'))
  if (!Number.isInteger(from) || from < 1 || !Number.isInteger(to) || to < 1) return libraryFail(event, 'version_not_found')
  const r = await compareVersions(libraryActorOf(a), getRouterParam(event, 'id')!, from, to)
  if (!r.ok) return libraryFail(event, r.code === 'not_found' ? 'version_not_found' : r.code)
  return apiData(r.compare)
})
