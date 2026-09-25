import { orgSnapshotListQuerySchema } from '../../../../shared/schemas/orgStructure'
import { requireScope } from '../../../services/access'
import { listSnapshotsPage } from '../../../services/orgSnapshots'
import { apiData, apiError } from '../../../utils/apiResponse'

/**
 * GET /org-structure/snapshots (docs/v2/32 §10): снимки, новые сверху, с ключевым курсором
 * (`docs/04` §4.1). Откат к снимку — `POST /org-structure/snapshots/:id/rollback`.
 */
export default defineEventHandler(async (event) => {
  const a = await requireScope(event, 'org.structure.import')
  const q = orgSnapshotListQuerySchema.safeParse(getQuery(event))
  if (!q.success) return apiError(event, 400, 'validation_failed', 'Курсор недійсний — оновіть список', { issues: q.error.issues })
  return apiData(await listSnapshotsPage({ tenantId: a.tenantId, actorId: a.userId }, q.data))
})
