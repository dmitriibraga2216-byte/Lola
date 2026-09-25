import { requireScope } from '../../../../services/access'
import { personTracks } from '../../../../services/personTracks'
import { apiData, apiError } from '../../../../utils/apiResponse'

/**
 * Блок «Етап» карточки (docs/v2/33 §5.3, docs/v2/38 §5.1; PR-35): текущий этап человека с датой
 * входа и «Призначені треки» по этапам — процент, срок со светофором, «Пройдено модулів X/Y»,
 * «Плановий час» и «Час проходження» (время — тому, кому видно время человека, `docs/v2/37` §2).
 * Скоуп — как у остальных вкладок карточки (`people.view`); кандидат и чужой тенант — `404`.
 */
export default defineEventHandler(async (event) => {
  const access = await requireScope(event, 'people.view')
  const r = await personTracks(access, getRouterParam(event, 'id')!)
  return r.ok ? apiData(r.data) : apiError(event, 404, 'not_found', 'Людину не знайдено')
})
