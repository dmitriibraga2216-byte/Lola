import { libraryProposalAcceptSchema } from '../../../../../../shared/schemas/library'
import { requireScope } from '../../../../../services/access'
import { libraryActorOf } from '../../../../../services/library'
import { acceptProposal } from '../../../../../services/libraryProposals'
import { apiData } from '../../../../../utils/apiResponse'
import { libraryFail, libraryValidationFail } from '../../../../../utils/libraryErrors'

/** POST /library/proposals/:id/accept `{categoryId?, ownerId?}` → `{libraryModuleId}` (docs/v2/31 §10): появляется модуль-черновик с копией тела урока. */
export default defineEventHandler(async (event) => {
  const a = await requireScope(event, 'library.publish')
  const p = libraryProposalAcceptSchema.safeParse((await readBody(event)) ?? {})
  if (!p.success) return libraryValidationFail(event, p.error)
  const r = await acceptProposal(libraryActorOf(a), getRouterParam(event, 'id')!, p.data)
  if (!r.ok) return libraryFail(event, r.code === 'not_found' ? 'proposal_not_found' : r.code)
  return apiData({ ...r.proposal, libraryModuleId: r.libraryModuleId })
})
