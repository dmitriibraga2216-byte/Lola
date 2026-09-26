import { tenantListQuerySchema } from '../../../../shared/schemas/platformOperators'
import { platformCan } from '../../../../shared/domain/platformRoles'
import { listTenantsPage } from '../../../services/platformConsole'
import { apiError } from '../../../utils/apiResponse'
import { requirePlatform } from '../../../utils/platformGuard'

/**
 * GET /platform/companies?q=&plan=&status=&flag=&cursor= — список компаний консоли постранично
 * (ключевой курсор `created_at desc, id desc`, docs/04 §4.1) с метками «прострочена оплата»,
 * «ліміт майже вичерпано», «призупинена». Старый `GET /platform/tenants` (всё сразу) остаётся для
 * прежней страницы `/ops`, пока новая консоль её не заменит.
 */
export default defineEventHandler(async (event) => {
  const op = requirePlatform(event, 'tenant.read')
  const q = tenantListQuerySchema.safeParse(getQuery(event))
  if (!q.success) return apiError(event, 400, 'validation_failed', 'Некоректний фільтр або курсор — оновіть сторінку', { issues: q.error.issues })
  const r = await listTenantsPage(q.data, { withBilling: platformCan(op.role, 'billing.read') })
  return { data: r.items, meta: { cursor: r.cursor } }
})
