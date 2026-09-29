import { candidateInviteSchema } from '../../../../../shared/schemas/candidates'
import { requireScope } from '../../../../services/access'
import { viewerOf } from '../../../../services/candidates'
import { inviteCandidate } from '../../../../services/candidateInvite'
import { apiData, apiError } from '../../../../utils/apiResponse'

/**
 * POST /candidates/:id/invite — приглашение кандидата (docs/v2/28 §7.12, §8 `candidate.invited`, §10).
 *
 * Право — `candidate.assign` (§2 «Назначать контент»: рекрутер, HR): приглашение — это «пройдіть
 * матеріали за посиланням». Ссылка входа в ответ не попадает — только кандидату (`candidateInvite.ts`).
 */
export default defineEventHandler(async (event) => {
  const a = await requireScope(event, 'candidate.assign')
  const p = candidateInviteSchema.safeParse((await readBody(event)) ?? {})
  if (!p.success) return apiError(event, 422, 'validation_failed', 'Оберіть канал запрошення', { issues: p.error.issues })
  const r = await inviteCandidate(viewerOf(a), getRouterParam(event, 'id')!, p.data)
  if (r.ok) return apiData({ sentAt: r.sentAt, channels: r.channels, skipped: r.skipped })
  switch (r.code) {
    case 'not_found': return apiError(event, 404, 'not_found', 'Кандидата не знайдено')
    case 'not_active': return apiError(event, 409, 'candidate.not_active', 'Кандидат уже не у відборі — запрошення не надсилається', { state: r.state })
    case 'access_expired': return apiError(event, 409, 'candidate.access_expired', 'Термін доступу кандидата завершився — продовжте його в картці, потім запросіть')
    case 'too_often':
      return r.reason === 'total'
        ? apiError(event, 429, 'invite.too_often', 'Кандидату вже надіслано 5 запрошень — більше надсилати не можна', { reason: r.reason })
        : apiError(event, 429, 'invite.too_often', 'Запрошення можна надсилати не частіше ніж раз на добу', { reason: r.reason, retryAt: r.retryAt })
    case 'contact_missing': return apiError(event, 422, 'contact.missing', 'Для обраних каналів у кандидата немає контактів — додайте телефон чи e-mail', { missing: r.missing })
  }
})
