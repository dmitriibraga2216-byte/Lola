import { orgSourceOfTruthSchema } from '../../../../shared/schemas/orgStructure'
import { requireScope } from '../../../services/access'
import { enableSourceOfTruth, SOURCE_OF_TRUTH_MIN_NODES } from '../../../services/orgJobs'
import { apiData, apiError } from '../../../utils/apiResponse'

/**
 * POST /org-structure/source-of-truth (docs/v2/32 §7.8): дерево становится источником истины
 * о руководителе — флаг `org_structure_is_source_of_truth` в `true` с подтверждением
 * администратора. Только `org.structure.edit` на весь тенант: руководитель своей ветки не
 * решает за всю сеть, кто чей начальник.
 */
export default defineEventHandler(async (event) => {
  const a = await requireScope(event, 'org.structure.edit')
  if (!a.grants.some(g => g.scopes.includes('org.structure.edit') && g.scopeType === 'tenant')) {
    return apiError(event, 403, 'forbidden', 'Увімкнути дерево як джерело істини може лише адміністратор простору')
  }
  const p = orgSourceOfTruthSchema.safeParse(await readBody(event))
  if (!p.success) return apiError(event, 422, 'validation_failed', 'Підтвердьте перехід: керівників буде визначати дерево', { issues: p.error.issues })
  const r = await enableSourceOfTruth({ tenantId: a.tenantId, actorId: a.userId })
  if (!r.ok) return apiError(event, 409, 'too_few_nodes', `У дереві має бути щонайменше ${SOURCE_OF_TRUTH_MIN_NODES} вузлів — зараз ${r.liveNodes}. Додайте вузли й повторіть`)
  return apiData(r)
})
