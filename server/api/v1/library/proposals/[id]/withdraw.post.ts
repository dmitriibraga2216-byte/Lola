import { requireScope } from '../../../../../services/access'
import { libraryActorOf } from '../../../../../services/library'
import { withdrawProposal } from '../../../../../services/libraryProposals'
import { apiData } from '../../../../../utils/apiResponse'
import { libraryFail } from '../../../../../utils/libraryErrors'

/**
 * POST /library/proposals/:id/withdraw — автор отзывает своё предложение, пока решения нет
 * (docs/v2/31 §4: `pending → withdrawn`). В таблице §10 этой ручки нет, а статус `withdrawn`
 * есть — без неё в него не попасть.
 */
export default defineEventHandler(async (event) => {
  const a = await requireScope(event, 'library.use')
  const r = await withdrawProposal(libraryActorOf(a), getRouterParam(event, 'id')!)
  if (!r.ok) return libraryFail(event, r.code === 'not_found' ? 'proposal_not_found' : r.code)
  return apiData(r.proposal)
})
