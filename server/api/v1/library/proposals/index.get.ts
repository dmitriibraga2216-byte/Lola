import { libraryProposalsQuerySchema } from '../../../../../shared/schemas/library'
import { requireScope } from '../../../../services/access'
import { libraryActorOf } from '../../../../services/library'
import { listProposals } from '../../../../services/libraryProposals'
import { apiData } from '../../../../utils/apiResponse'
import { libraryValidationFail } from '../../../../utils/libraryErrors'

/** GET /library/proposals — куратор (`library.publish`) видит все предложения, остальные — свои (docs/v2/31 §2, §10). */
export default defineEventHandler(async (event) => {
  const a = await requireScope(event, 'library.view')
  const p = libraryProposalsQuerySchema.safeParse(getQuery(event))
  if (!p.success) return libraryValidationFail(event, p.error)
  return apiData(await listProposals(libraryActorOf(a), p.data))
})
