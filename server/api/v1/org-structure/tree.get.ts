import { orgTreeQuerySchema } from '../../../../shared/schemas/orgStructure'
import { requireScope } from '../../../services/access'
import { editableBranches, listTree } from '../../../services/orgStructure'
import { sourceOfTruthStatus } from '../../../services/orgJobs'
import { listViewTreeCached } from '../../../services/orgTreeCache'
import { withTenant } from '../../../utils/withTenant'
import { apiData, apiError } from '../../../utils/apiResponse'

/**
 * GET /org-structure/tree (docs/v2/32 §10). Два режима одного дерева: `view` — витрина
 * без заметок и без скрытых людей, `admin` — конструктор. Режим `admin` требует
 * `org.structure.edit`; ответ несёт ветки, которые человек имеет право править
 * (`32` §2: «своя ветка» руководителя), чтобы клиент не гадал, где разрешён drop.
 * Администратору конструктора — ещё `sourceOfTruth`: включено ли дерево источником истины о
 * руководителе и можно ли предложить перевод (`32` §7.8, ≥ 5 живых узлов).
 * Витрина кэшируется на 5 минут со сверкой отметки дерева (`32` §7 п. 7, `44` Р-CC.6).
 */
export default defineEventHandler(async (event) => {
  const q = orgTreeQuerySchema.safeParse(getQuery(event))
  if (!q.success) return apiError(event, 400, 'validation_failed', 'Перевірте фільтри', { issues: q.error.issues })
  const mode = q.data.mode ?? 'view'
  const a = await requireScope(event, mode === 'admin' ? 'org.structure.edit' : 'org.structure.view')
  const ctx = { tenantId: a.tenantId, actorId: a.userId }
  const tree = mode === 'view'
    ? await listViewTreeCached(ctx, { includeArchived: q.data.includeArchived, includeVacant: q.data.includeVacant }).then(({ cached: _cached, ...t }) => t)
    : await listTree(ctx, { mode, includeArchived: q.data.includeArchived, includeVacant: q.data.includeVacant })
  const canEditAll = a.grants.some(g => g.scopes.includes('org.structure.edit') && g.scopeType === 'tenant')
  const branches = mode === 'admin' && !canEditAll ? await withTenant(a.tenantId, a.userId, tx => editableBranches(tx, a.userId)) : []
  const sourceOfTruth = mode === 'admin' && canEditAll ? await sourceOfTruthStatus(ctx) : null
  return apiData({ ...tree, mode, canEditAll, branches, sourceOfTruth })
})
