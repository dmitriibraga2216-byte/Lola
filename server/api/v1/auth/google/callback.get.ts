import { sql } from 'drizzle-orm'
import { handleCallback } from '../../../../services/oauth'
import { createSession } from '../../../../services/session'
import { logSecurity } from '../../../../services/securityLog'
import { withTenant } from '../../../../utils/withTenant'
import { clientIp, setSessionCookies } from '../../../../utils/authCookies'
/** Колбек входа через Google: e-mail из профиля → активный пользователь тенанта из state → сессия. */
export default defineEventHandler(async (event) => {
  const r = await handleCallback('google', getQuery(event) as { code?: string, state?: string, error?: string })
  if (!r.ok || r.purpose !== 'signin') return sendRedirect(event, `/login?error=${encodeURIComponent(r.ok ? 'bad_purpose' : r.code)}`)
  const rows = await withTenant(r.tenantId, null, tx => tx.execute(sql`select id from users where lower(email) = ${r.accountLabel.toLowerCase()} and status = 'active' limit 2`)) as unknown as { id: string }[]
  if (rows.length !== 1) return sendRedirect(event, '/login?error=google_no_user')
  const { token } = await createSession({ tenantId: r.tenantId, userId: rows[0]!.id, userAgent: getHeader(event, 'user-agent'), ip: clientIp(event), loginMethod: 'google' })
  setSessionCookies(event, token)
  await logSecurity({ tenantId: r.tenantId, userId: rows[0]!.id, event: 'login.success', meta: { method: 'google' }, ip: clientIp(event), userAgent: getHeader(event, 'user-agent') })
  return sendRedirect(event, '/')
})
