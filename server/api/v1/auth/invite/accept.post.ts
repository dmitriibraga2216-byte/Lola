import { eq } from 'drizzle-orm'
import { inviteAcceptSchema } from '../../../../../shared/schemas/auth'
import { invitationByTokenHash } from '../../../../services/authLookup'
import { assertCandidateMayEnter } from '../../../../services/candidateAccess'
import { createSession, hashToken } from '../../../../services/session'
import { logSecurity } from '../../../../services/securityLog'
import { invitations } from '../../../../db/schema'
import { withTenant } from '../../../../utils/withTenant'
import { apiData, apiError } from '../../../../utils/apiResponse'
import { clientIp, setSessionCookies } from '../../../../utils/authCookies'

/** Ссылка-приглашение с одноразовым токеном, 48 часов (docs/01-roles.md §1.5). */
export default defineEventHandler(async (event) => {
  const parsed = inviteAcceptSchema.safeParse(await readBody(event))
  if (!parsed.success) return apiError(event, 400, 'validation_failed', 'Невірний запит')

  const invite = await invitationByTokenHash(hashToken(parsed.data.token))
  if (!invite || invite.accepted_at || new Date(invite.expires_at) < new Date()) {
    return apiError(event, 401, 'invite_invalid', 'Запрошення недійсне або протухло')
  }
  // docs/v2/28 §7.7: закрытый вход кандидата отвечает до того, как ссылка потрачена, — иначе
  // повторный клик показал бы «запрошення протухло» вместо настоящей причины. Сессию то же
  // правило не выпустит и само (`createSession`), здесь — только порядок.
  await assertCandidateMayEnter(invite.tenant_id, invite.user_id)

  await withTenant(invite.tenant_id, invite.user_id, async (tx) => {
    await tx.update(invitations)
      .set({ acceptedAt: new Date() })
      .where(eq(invitations.id, invite.invitation_id))
  })

  const { token, twoFactor } = await createSession({
    tenantId: invite.tenant_id,
    userId: invite.user_id,
    userAgent: getHeader(event, 'user-agent'),
    ip: clientIp(event),
    loginMethod: 'invite',
  })
  setSessionCookies(event, token)

  // Второй фактор (docs/24 §3.4): приглашённому администратору его подключают на экране входа
  if (twoFactor) return apiData({ ok: true, twoFactor })

  await logSecurity({
    tenantId: invite.tenant_id,
    userId: invite.user_id,
    event: 'login.success',
    meta: { method: 'invite' },
    ip: clientIp(event),
  })

  return apiData({ ok: true, twoFactor: null })
})
