import { and, inArray, isNull, sql } from 'drizzle-orm'
import { sessions, users } from '../db/schema'
import { withTenant } from '../utils/withTenant'
import type { TenantTx } from '../utils/withTenant'
import type { CandidateState } from '../../shared/enums'
import { personById } from './repo/people'
import { logSecurity } from './securityLog'

/**
 * Право входа кандидата (docs/v2/28-recruiting-candidates.md §7.7, §3.2, §4.2, §12.8;
 * критерий §13 к. 7).
 *
 * Кандидат входит теми же путями, что и сотрудник: код на телефон или почту, выбор
 * пространства, пароль, ссылка-приглашение, Google, кнопка бота. Все они сходятся в
 * `createSession()` (`session.ts`), и решение принимается там — как и второй фактор: одна
 * точка на все пути, а не шесть копий правила, из которых однажды одну забудут.
 *
 * **Вход закрыт**, если `candidate_state` не `active` — отказ, архив, самоотвод (§7.7:
 * «вход запрещён, если `candidate_state != 'active'`»), — или если `access_until` раньше
 * сегодняшнего дня. Нанятый — уже `kind = 'employee'`, и правило к нему не относится вовсе:
 * сотрудник входит как все, без срока (§7.6). «Сегодня» — по поясу самого человека
 * (`personTimezone()`, одна цепочка на продукт), а не по UTC: «Доступ до 30-го» кончается в
 * полночь 30-го там, где человек живёт, а не в три часа ночи по Киеву.
 *
 * **Действующие сессии гаснут**, как только кандидат покидает `active`
 * (`closeCandidateSessionsTx()`): закрытый вход без этого ничего бы не закрывал — сессия живёт
 * 30 дней и продлевается сама. Истёкший `access_until` сессию **не** гасит: «доступ
 * проверяется на входе, а не на каждом запросе» (§12.8) — начатая попытка доводится до конца.
 *
 * Текст отказа один на все причины и причину не называет (§7.7): отказанный, архивный и
 * просроченный слышат одно и то же — «Термін доступу завершився».
 */

export const CANDIDATE_ACCESS_EXPIRED = 'candidate.access_expired'

/** Код для адреса возврата браузерных входов (Google, кнопка бота): `/login?error=…`. */
export const CANDIDATE_ACCESS_EXPIRED_REDIRECT = '/login?error=candidate_access_expired'

/** 403 `candidate.access_expired` — формат тот же, что у `TenantClosedError` и `LoginFormHiddenError`. */
export class CandidateAccessExpiredError extends Error {
  statusCode = 403
  data = { code: CANDIDATE_ACCESS_EXPIRED, message: 'Термін доступу завершився. Зверніться до рекрутера.' }
  constructor() { super(CANDIDATE_ACCESS_EXPIRED) }
}

/**
 * Открыт ли человеку вход в пространство. Сотрудник — всегда `true`: его вход решают статус,
 * блокировка и политики, а не это правило. Человека нет — тоже `true`: отвечать о чужом
 * отсутствии здесь нечем, это сделает вставка сессии.
 */
export async function candidateMayEnter(tenantId: string, userId: string): Promise<boolean> {
  return withTenant(tenantId, userId, async (tx) => {
    const [person] = await personById(tx, { kind: users.kind, state: users.candidateState, accessUntil: users.accessUntil }, userId) as unknown as { kind: string, state: CandidateState | null, accessUntil: string | null }[]
    if (!person || person.kind !== 'candidate') return true
    if (person.state !== 'active') return false
    if (!person.accessUntil) return true
    // Лениво: activity.ts тянет каркас отчётов и карточку человека, а вход — горячий путь
    const { personTimezone } = await import('./activity')
    const { tz } = await personTimezone(tx, userId)
    const [row] = await tx.execute(sql`select ${person.accessUntil}::date < (now() at time zone ${tz})::date as expired`) as unknown as { expired: boolean }[]
    return row?.expired !== true
  })
}

/** Бросает `CandidateAccessExpiredError`, если вход закрыт, — для точек, которые отвечают исключением. */
export async function assertCandidateMayEnter(tenantId: string, userId: string): Promise<void> {
  if (!await candidateMayEnter(tenantId, userId)) throw new CandidateAccessExpiredError()
}

/**
 * Закрыть действующие сессии кандидатов, у которых только что закрылся доступ (§4.2: отказ,
 * архив, самоотвод, стирание ПД). Зовётся **в транзакции смены состояния** — теми же строками,
 * что двигают ось: смена состояния без закрытия сессий оставила бы «архивного» кандидата в
 * системе до конца скользящего срока.
 *
 * Каждое закрытие — `session.revoked` в журнал безопасности, как при архивации сотрудника
 * (`people.archivePerson`): администратор видит, почему у человека кончилась сессия. Кандидаты
 * без действующих сессий в журнал не попадают — закрывать было нечего.
 */
export async function closeCandidateSessionsTx(tx: TenantTx, tenantId: string, ids: string[], meta: { by: string | null, state: CandidateState }): Promise<number> {
  if (!ids.length) return 0
  const rows = await tx.update(sessions)
    .set({ revokedAt: new Date() })
    .where(and(inArray(sessions.userId, ids), isNull(sessions.revokedAt)))
    .returning({ userId: sessions.userId })
  const perUser = new Map<string, number>()
  for (const r of rows) perUser.set(r.userId, (perUser.get(r.userId) ?? 0) + 1)
  for (const [userId, closed] of perUser) {
    await logSecurity({ tenantId, userId, event: 'session.revoked', meta: { by: meta.by, reason: 'candidate_access', state: meta.state, closed } })
  }
  return rows.length
}
