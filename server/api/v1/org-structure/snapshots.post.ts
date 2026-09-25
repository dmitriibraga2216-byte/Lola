import { orgSnapshotCreateSchema } from '../../../../shared/schemas/orgStructure'
import { requireScope } from '../../../services/access'
import { createSnapshot } from '../../../services/orgStructure'
import { apiData, apiError } from '../../../utils/apiResponse'

/** POST /org-structure/snapshots (docs/v2/32 §10): снимок «руками» («Знімок»). */
export default defineEventHandler(async (event) => {
  const a = await requireScope(event, 'org.structure.import')
  const p = orgSnapshotCreateSchema.safeParse(await readBody(event))
  if (!p.success) return apiError(event, 422, 'validation_failed', 'Вкажіть назву знімка', { issues: p.error.issues })
  return apiData(await createSnapshot({ tenantId: a.tenantId, actorId: a.userId }, p.data))
})
