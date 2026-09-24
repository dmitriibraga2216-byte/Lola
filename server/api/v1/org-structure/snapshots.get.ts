import { requireScope } from '../../../services/access'
import { listSnapshots } from '../../../services/orgStructure'
import { apiData } from '../../../utils/apiResponse'

/** GET /org-structure/snapshots (docs/v2/32 §10). Откат к снимку — PR-31. */
export default defineEventHandler(async (event) => {
  const a = await requireScope(event, 'org.structure.import')
  return apiData({ rows: await listSnapshots({ tenantId: a.tenantId, actorId: a.userId }) })
})
