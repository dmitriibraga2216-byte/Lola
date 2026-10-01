import { roleAssignSchema } from '../../../../../shared/schemas/people'
import { requireScope } from '../../../../services/access'
import { assignRole, OWNER_NOT_ASSIGNABLE } from '../../../../services/people'
import { assertPersonAccess, checkRoleAssign } from '../../../../services/personGuard'
import { apiData, apiError } from '../../../../utils/apiResponse'

export default defineEventHandler(async (event) => {
  const access = await requireScope(event, 'role.assign')
  const parsed = roleAssignSchema.safeParse(await readBody(event))
  if (!parsed.success) {
    return apiError(event, 400, 'validation_failed', 'Перевірте поля', { issues: parsed.error.issues })
  }
  const personId = getRouterParam(event, 'id')!
  await assertPersonAccess(access, 'role.assign', personId)
  // Роль не ширша за власні права й область, і не собі — як при створенні ролі (security-sweep-1)
  if (!await checkRoleAssign(access, personId, parsed.data)) {
    return apiError(event, 403, 'scope_not_owned', 'Цю роль або область може видати лише адміністратор')
  }
  const assigned = await assignRole(
    { tenantId: access.tenantId, actorId: access.userId },
    personId,
    parsed.data,
  )
  if (assigned === OWNER_NOT_ASSIGNABLE) return apiError(event, 409, 'owner_role', 'Володіння не призначають роллю — його передає чинний власник на екрані «Ролі та права»')
  if (!assigned) return apiError(event, 404, 'not_found', 'Роль не знайдено')
  return apiData(assigned)
})
