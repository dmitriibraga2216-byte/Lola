import { libraryProposalRejectSchema } from '../../../../../../shared/schemas/library'
import { requireScope } from '../../../../../services/access'
import { libraryActorOf } from '../../../../../services/library'
import { rejectProposal } from '../../../../../services/libraryProposals'
import { apiData } from '../../../../../utils/apiResponse'
import { libraryFail, libraryValidationFail } from '../../../../../utils/libraryErrors'

/** POST /library/proposals/:id/reject `{decisionComment}` (docs/v2/31 §10): без комментария — `422 comment_required`. */
export default defineEventHandler(async (event) => {
  const a = await requireScope(event, 'library.publish')
  const p = libraryProposalRejectSchema.safeParse((await readBody(event)) ?? {})
  if (!p.success) return libraryValidationFail(event, p.error, 'Поясніть рішення — його побачить автор пропозиції')
  const r = await rejectProposal(libraryActorOf(a), getRouterParam(event, 'id')!, p.data.decisionComment)
  if (!r.ok) return libraryFail(event, r.code === 'not_found' ? 'proposal_not_found' : r.code)
  return apiData(r.proposal)
})
