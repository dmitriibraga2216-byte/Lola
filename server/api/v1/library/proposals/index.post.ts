import { libraryProposalCreateSchema } from '../../../../../shared/schemas/library'
import { requireScope } from '../../../../services/access'
import { libraryActorOf } from '../../../../services/library'
import { createProposal } from '../../../../services/libraryProposals'
import { apiData } from '../../../../utils/apiResponse'
import { libraryFail, libraryValidationFail } from '../../../../utils/libraryErrors'

/**
 * POST /library/proposals — «Запропонувати в бібліотеку» (docs/v2/31 §6.3, §7.11, §10).
 * Носитель `library.use` без `library.publish` получает предложение `pending`, модуль не
 * создаётся (критерий приёмки 5). Повторная подача — `409 proposal_pending`.
 */
export default defineEventHandler(async (event) => {
  const a = await requireScope(event, 'library.use')
  const p = libraryProposalCreateSchema.safeParse(await readBody(event))
  if (!p.success) return libraryValidationFail(event, p.error)
  const r = await createProposal(libraryActorOf(a), p.data)
  if (!r.ok) return libraryFail(event, r.code)
  return apiData(r.proposal)
})
