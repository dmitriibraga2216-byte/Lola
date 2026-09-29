import { randomBytes } from 'node:crypto'
import { desc, eq, sql } from 'drizzle-orm'
import { invitations, users } from '../db/schema'
import { withTenant } from '../utils/withTenant'
import type { CandidateState } from '../../shared/enums'
import type { CandidateDeleteInput, CandidateInviteChannel, CandidateInviteInput } from '../../shared/schemas/candidates'
import { candidates as candidatesQuery, personById } from './repo/people'
import { scopeCond } from './candidates'
import type { Viewer } from './candidates'
import { anonymizeCandidate } from './candidateHire'
import { candidateMayEnter } from './candidateAccess'
import { enqueueNotification } from './notifications'
import { recordAudit } from './audit'
import { hashToken } from './session'

/**
 * Приглашение и удаление кандидата (docs/v2/28-recruiting-candidates.md §7.12, §8, §10;
 * решения — docs/v2/44 Р-CT.1…Р-CT.5).
 *
 * **Приглашение** — одноразовая ссылка входа (та же `invitations`, что у сотрудника, docs/01
 * §1.5) и уведомление `candidate_invited` по выбранным каналам. Ссылка уходит только кандидату:
 * рекрутеру ответ её не возвращает — по ней входят **как кандидат**, и копия в чужих руках была бы
 * входом в чужую учётную запись.
 *
 * Частота (§7.12): не чаще раза в 24 часа и не больше пяти раз всего. Счёт — по строкам
 * `invitations` этого человека: это и есть «отправленные приглашения», отдельного счётчика нет,
 * и приглашение, выданное любым путём, считается одинаково. Строка кандидата блокируется
 * `for update` до проверки — два одновременных нажатия не проходят оба.
 *
 * **Удаление** (право на забвение, §2 «только HR / Админ», §10 `DELETE /candidates/:id`) — не
 * `delete from users`, а то же обезличивание, что делает `candidate.consent_sweep` (§7.9):
 * прохождение и оценки остаются статистикой, ПД уходят. Второго механизма стирания нет.
 */

/** Пауза между приглашениями одному кандидату (§7.12). */
export const INVITE_INTERVAL_MS = 24 * 60 * 60 * 1000
/** Всего приглашений одному кандидату (§7.12). */
export const INVITE_MAX_TOTAL = 5
/** Срок ссылки — как у приглашения сотрудника (docs/01 §1.5, `createInvitation`). */
export const INVITE_TTL_MS = 48 * 60 * 60 * 1000

export type InviteResult =
  | { ok: true, sentAt: Date, channels: CandidateInviteChannel[], skipped: CandidateInviteChannel[] }
  | { ok: false, code: 'not_found' }
  | { ok: false, code: 'not_active', state: CandidateState }
  | { ok: false, code: 'access_expired' }
  | { ok: false, code: 'too_often', reason: 'interval' | 'total', retryAt: Date | null }
  | { ok: false, code: 'contact_missing', missing: CandidateInviteChannel[] }

interface InviteTarget {
  id: string
  state: CandidateState
  phone: string | null
  email: string | null
  telegramChatId: string | null
  accessUntil: string | null
  vacancyTitle: string | null
}

/** Есть ли у кандидата адрес для канала. Канал без адреса пропускается, а не падает (Р-CT.2). */
function reachable(t: InviteTarget, channel: CandidateInviteChannel): boolean {
  switch (channel) {
    case 'email': return !!t.email
    case 'sms': return !!t.phone
    case 'telegram': return !!t.telegramChatId
  }
}

/**
 * `POST /candidates/:id/invite` (§10). Порядок проверок — от «кого» к «как»: нет кандидата
 * (или он вне области смотрящего) → закрыт вход → частота → адреса. Частота проверяется раньше
 * адресов: иначе по ответу `422`/`429` можно было бы выяснять, какие контакты у человека есть,
 * обходя маскирование (§7.10).
 */
export async function inviteCandidate(v: Viewer, id: string, input: CandidateInviteInput, opts: { now?: Date } = {}): Promise<InviteResult> {
  const now = opts.now ?? new Date()
  const channels = [...new Set(input.channels)]

  // Закрытый вход (§7.7) — одной функцией с `createSession()`: приглашение, по которому нельзя
  // войти, — это письмо «Термін доступу завершився» вместо материалов
  const mayEnter = await candidateMayEnter(v.tenantId, id)

  return withTenant(v.tenantId, v.actorId, async (tx) => {
    const [target] = await candidatesQuery(tx, {
      id: users.id,
      state: users.candidateState,
      phone: users.phone,
      email: users.email,
      telegramChatId: users.telegramChatId,
      accessUntil: users.accessUntil,
      vacancyTitle: sql<string | null>`(select vv.title from vacancies vv where vv.id = ${sql.raw('users.vacancy_id')})`,
    }, eq(users.id, id), scopeCond(v)).for('update', { of: users }) as unknown as InviteTarget[]
    if (!target) return { ok: false, code: 'not_found' }
    if (target.state !== 'active') return { ok: false, code: 'not_active', state: target.state }
    if (!mayEnter) return { ok: false, code: 'access_expired' }

    const sent = await tx.select({ createdAt: invitations.createdAt }).from(invitations)
      .where(eq(invitations.userId, id))
      .orderBy(desc(invitations.createdAt))
    if (sent.length >= INVITE_MAX_TOTAL) return { ok: false, code: 'too_often', reason: 'total', retryAt: null }
    const last = sent[0]?.createdAt
    if (last && now.getTime() - new Date(last).getTime() < INVITE_INTERVAL_MS) {
      return { ok: false, code: 'too_often', reason: 'interval', retryAt: new Date(new Date(last).getTime() + INVITE_INTERVAL_MS) }
    }

    const usable = channels.filter(c => reachable(target, c))
    const skipped = channels.filter(c => !usable.includes(c))
    if (!usable.length) return { ok: false, code: 'contact_missing', missing: skipped }

    const token = randomBytes(24).toString('base64url')
    const [invite] = await tx.insert(invitations).values({
      tenantId: v.tenantId,
      userId: id,
      tokenHash: hashToken(token),
      expiresAt: new Date(now.getTime() + INVITE_TTL_MS),
      createdBy: v.actorId,
      createdAt: now,
    }).returning({ id: invitations.id })

    const url = `${process.env.APP_URL ?? ''}/invite?token=${token}`
    for (const channel of usable) {
      await enqueueNotification(tx, {
        tenantId: v.tenantId,
        userId: id,
        code: 'candidate_invited',
        channel,
        // Дата доступа — полднем UTC: шаблон форматирует ISO-момент «30 вересня», а голая дата
        // осталась бы как есть; полдень не переезжает на соседний день ни в одном поясе Европы
        payload: { vacancy: target.vacancyTitle ?? '', url, until: target.accessUntil ? `${target.accessUntil}T12:00:00Z` : '' },
        dedupKey: `candidate_invited:${invite!.id}:${channel}`,
        refType: 'user',
        refId: id,
      })
    }

    await recordAudit(tx, {
      tenantId: v.tenantId,
      actorId: v.actorId,
      action: 'candidate.invited',
      entity: 'user',
      entityId: id,
      after: { invitationId: invite!.id, channels: usable, skipped, number: sent.length + 1 },
    })
    return { ok: true, sentAt: now, channels: usable, skipped }
  })
}

export type DeleteResult =
  | { ok: true, erased: boolean }
  | { ok: false, code: 'not_found' | 'hired' }

/**
 * `DELETE /candidates/:id` — право на забвение (§2, §7.9, §10). Нанятый — уже сотрудник: его
 * ПД живут по правилам сотрудника, и путь отсюда закрыт `409 candidate.hired`. Уже обезличенный —
 * `erased: false` и тот же `204`: повтор запроса не ошибка, стирать нечего (Р-CT.4).
 */
export async function deleteCandidate(v: Viewer, id: string, input: CandidateDeleteInput): Promise<DeleteResult> {
  return withTenant(v.tenantId, v.actorId, async (tx) => {
    // По первичному ключу и без фильтра по виду — ровно чтобы отличить нанятого от чужого: первому
    // `409`, второму `404`. Нанятый — сотрудник (`kind = 'employee'`, `candidate_state` обнулён
    // найма ради `users_candidate_coherence_chk`), у которого осталась история воронки (§7.6)
    const [person] = await personById(tx, {
      kind: users.kind,
      wasCandidate: sql<boolean>`exists (select 1 from candidate_status_history h where h.candidate_id = ${sql.raw('users.id')})`,
    }, id) as unknown as { kind: string, wasCandidate: boolean }[]
    if (person?.kind === 'employee' && person.wasCandidate) return { ok: false, code: 'hired' }
    const [visible] = await candidatesQuery(tx, { id: users.id, anonymizedAt: users.anonymizedAt }, eq(users.id, id), scopeCond(v))
      .for('update', { of: users }) as unknown as { id: string, anonymizedAt: Date | null }[]
    if (!visible) return { ok: false, code: 'not_found' }
    if (visible.anonymizedAt) return { ok: true, erased: false }
    const erased = await anonymizeCandidate(tx, v.tenantId, id, v.actorId, 'erasure_request', input.reasonText)
    return { ok: true, erased }
  })
}
