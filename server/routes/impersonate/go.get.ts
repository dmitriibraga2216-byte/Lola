import { openHandoff } from '../../services/impersonationHandoff'
import { hitRateLimit } from '../../services/rateLimit'
import { validateSession } from '../../services/session'
import { clientIp, hostTenantIdOf, setSessionCookies } from '../../utils/authCookies'

/**
 * `GET /impersonate/go?h=…` — хост тенанта принимает вход «от имени», начатый в консоли оператора
 * на её отдельном хосте (docs/24 §4.5, docs/25 §7 п. 6). Ссылка одноразовая, 60 секунд; сессия
 * обязана принадлежать тенанту этого хоста. Любой отказ — экран входа без подробностей.
 */
export default defineEventHandler(async (event) => {
  setHeader(event, 'Cache-Control', 'no-store')
  setHeader(event, 'Referrer-Policy', 'no-referrer')
  if (!await hitRateLimit(`imp:go:${clientIp(event)}`, 30, 600)) return sendRedirect(event, '/login')
  const h = String(getQuery(event).h ?? '')
  const token = h ? await openHandoff(h) : null
  const auth = token ? await validateSession(token) : null
  const hostTenant = hostTenantIdOf(event)
  if (!token || !auth || !auth.impersonatorAdminId || (hostTenant && hostTenant !== auth.tenantId)) return sendRedirect(event, '/login')
  setSessionCookies(event, token)
  return sendRedirect(event, '/')
})
