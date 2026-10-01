import { orgSnapshotCreateSchema } from '../../../../shared/schemas/orgStructure'
import { requireScope } from '../../../services/access'
import { createSnapshot } from '../../../services/orgStructure'
import { apiData, apiError } from '../../../utils/apiResponse'
import { idempotent } from '../../../utils/idempotency'

/** POST /org-structure/snapshots (docs/v2/32 §10): снимок «руками» («Знімок»). */
export default defineEventHandler(async (event) => {
  const a = await requireScope(event, 'org.structure.import')
  // docs/v2/32 §10: мутации идемпотентны по Idempotency-Key (Р-CC.3)
  return idempotent(event, a, async () => {
    const p = orgSnapshotCreateSchema.safeParse(await readBody(event))
    if (!p.success) return apiError(event, 422, 'validation_failed', 'Вкажіть назву знімка', { issues: p.error.issues })
    return apiData(await createSnapshot({ tenantId: a.tenantId, actorId: a.userId }, p.data))
  })
})
