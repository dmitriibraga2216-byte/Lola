import { requireScope } from '../../../../../services/access'
import { libraryActorOf } from '../../../../../services/library'
import { detachUsage } from '../../../../../services/libraryUsages'
import { apiData } from '../../../../../utils/apiResponse'
import { libraryFail } from '../../../../../utils/libraryErrors'

/**
 * POST /library/usages/:id/detach — «Відʼєднати і зробити копією» (docs/v2/31 §7.10, §10).
 * Урок курса всегда получает копию тела закреплённой версии (урок без материала не бывает),
 * ответ — `{lessonId}`; у узла трека до PR-26 отвязка закрывает только строку реестра, и
 * `makeCopy` из §10 для него появится вместе со ссылкой в самом узле.
 */
export default defineEventHandler(async (event) => {
  const a = await requireScope(event, 'library.use')
  const r = await detachUsage(libraryActorOf(a), getRouterParam(event, 'id')!)
  if (!r.ok) return libraryFail(event, r.code === 'not_found' ? 'usage_not_found' : r.code)
  return apiData({ lessonId: r.lessonId })
})
