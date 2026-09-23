import { and, eq, isNull, lt, sql } from 'drizzle-orm'
import { candidateStatusHistory, candidateStatuses, users } from '../db/schema'
import { withTenant } from '../utils/withTenant'
import type { TenantTx } from '../utils/withTenant'
import { candidateOnly, candidates as candidatesQuery, personById } from './repo/people'
import { anonymizeCandidate } from './candidateHire'
import { recordAudit } from './audit'
import { enqueueNotification } from './notifications'
import { readSettings } from './settings'

/**
 * Автоматика воронки: две ночные задачи и авто-переходы колонки канбана
 * (docs/v2/28-recruiting-candidates.md §4.3, §7.4, §7.5, §7.9, §11; план docs/v2/45 PR-14).
 *
 * Общее правило всех трёх: **система не принимает решений о людях** (инвариант 18 пакета).
 * Она архивирует отказ, сделанный человеком, стирает данные по истёкшему согласию и двигает
 * карточку в колонку «На перевірці». Чего она не делает никогда — не отказывает кандидату:
 * провал обязательного задания ставит статус и зовёт рекрутера (§7.4), потому что
 * автоматический отказ по формальному результату — дорогая ошибка и юридически решение,
 * требующее обжалования.
 */

/** Колонка канбана по коду (шесть системных, §3.3). */
async function statusByCode(tx: TenantTx, code: string) {
  const [row] = await tx.select().from(candidateStatuses)
    .where(and(eq(candidateStatuses.code, code), eq(candidateStatuses.isActive, true)))
  return row ?? null
}

// ── candidate.auto_archive (§7.5, §11) ─────────────────────────────────────────────────────

/**
 * Отказанные старше N дней уходят в архив (§7.5). N настраивает тенант
 * (`settings.recruiting.archiveAfterDays`, по умолчанию 30, диапазон 7–365); выключенный
 * тумблер `autoArchiveRejected` останавливает задачу целиком — тенант вправе хранить отказы
 * в воронке, пока сам их не уберёт.
 *
 * Архивация закрывает доступ кандидата, но **не стирает данные**: стирание — отдельное
 * правило §7.9 и отдельная задача, у него другой срок и другая необратимость.
 */
export async function candidateAutoArchive(tenantId: string): Promise<number> {
  const settings = await withTenant(tenantId, null, tx => readSettings(tx, tenantId))
  if (!settings.recruiting.autoArchiveRejected) return 0
  const days = settings.recruiting.archiveAfterDays

  return withTenant(tenantId, null, async (tx) => {
    const archived = await statusByCode(tx, 'archived')
    const rows = await candidatesQuery(tx, { id: users.id, statusId: users.candidateStatusId }, and(
      eq(users.candidateState, 'rejected'),
      lt(users.candidateStateAt, sql`now() - make_interval(days => ${days})`),
    )) as unknown as { id: string, statusId: string | null }[]
    if (!rows.length) return 0

    for (const row of rows) {
      await tx.update(users).set({
        candidateState: 'archived',
        candidateStateAt: new Date(),
        updatedAt: new Date(),
      }).where(and(eq(users.id, row.id), candidateOnly()))
      // Колонки «Архів» среди шести системных нет (§3.3) — если тенант её не завёл, карточка
      // остаётся в «Відхилені», а архив виден осью состояния. Историю пишем только когда
      // колонка действительно меняется: журнал колонок не должен содержать переходов в себя.
      if (archived && archived.id !== row.statusId) {
        await tx.insert(candidateStatusHistory).values({
          tenantId,
          candidateId: row.id,
          fromStatusId: row.statusId,
          toStatusId: archived.id,
          reasonCode: 'auto_archive',
          actorId: null,
          isAutomatic: true,
          requestContext: null, // фоновая задача: HTTP-контекста нет, и это норма (CLAUDE.md п. 14)
        })
      }
      await recordAudit(tx, {
        tenantId,
        actorId: null,
        action: 'candidate.archived',
        entity: 'user',
        entityId: row.id,
        before: { state: 'rejected' },
        after: { state: 'archived', reasonCode: 'auto_archive', afterDays: days },
      })
    }
    return rows.length
  })
}

// ── candidate.consent_sweep (§7.9, §11) ────────────────────────────────────────────────────

export interface SweepResult {
  /** Скольким кандидатам стёрли ПД. */
  erased: number
  /** По скольким предупредили рекрутера за 14 дней до стирания. */
  warned: number
}

const WARN_DAYS = 14

/**
 * Стирание ПД по истёкшему согласию и предупреждение за 14 дней (§7.9).
 *
 * Предупреждение живёт здесь, а не отдельной задачей `candidate.consent_warn` (§11): оба
 * прохода идут по одному индексу и по одному определению срока, а две задачи с разным
 * расписанием — это две копии правила «когда истекает согласие», которые однажды разойдутся.
 * Расписание задачи от этого не меняется: ночной проход в 03:20.
 *
 * Стирание необратимо и не откатывается: цикл идёт по одному кандидату за транзакцию, чтобы
 * ошибка на сотом не вернула девяносто девять уже стёртых обратно с их телефонами.
 */
export async function candidateConsentSweep(tenantId: string): Promise<SweepResult> {
  const today = new Date().toISOString().slice(0, 10)
  const warnUntil = new Date(Date.now() + WARN_DAYS * 86_400_000).toISOString().slice(0, 10)

  const { due, soon } = await withTenant(tenantId, null, async (tx) => {
    const rows = await candidatesQuery(tx, {
      id: users.id,
      fullName: users.fullName,
      recruiterId: users.recruiterId,
      consentExpiresAt: users.consentExpiresAt,
    }, and(
      isNull(users.anonymizedAt),
      sql`${users.consentExpiresAt} is not null`,
      sql`${users.consentExpiresAt} <= ${warnUntil}`,
    )) as unknown as { id: string, fullName: string, recruiterId: string | null, consentExpiresAt: string }[]
    return {
      due: rows.filter(r => r.consentExpiresAt <= today),
      soon: rows.filter(r => r.consentExpiresAt > today),
    }
  })

  let erased = 0
  for (const row of due) {
    const ok = await withTenant(tenantId, null, tx => anonymizeCandidate(tx, tenantId, row.id, null, 'consent_expired'))
      .catch((err) => { console.error('consent_sweep', row.id, err); return false })
    if (ok) erased += 1
  }

  // Предупреждение — рекрутеру карточки; без него человек узнаёт о стирании постфактум.
  const byRecruiter = new Map<string, number>()
  for (const row of soon) {
    if (!row.recruiterId) continue
    byRecruiter.set(row.recruiterId, (byRecruiter.get(row.recruiterId) ?? 0) + 1)
  }
  let warned = 0
  for (const [recruiterId, n] of byRecruiter) {
    const sent = await withTenant(tenantId, null, tx => enqueueNotification(tx, {
      tenantId,
      userId: recruiterId,
      code: 'candidate_consent_expiring',
      channel: 'email',
      payload: { n },
      dedupKey: `candidate_consent_expiring:${recruiterId}:${today}`,
    })).catch(() => false)
    if (sent) warned += 1
  }
  return { erased, warned }
}

// ── Авто-переходы колонки канбана (§4.3, §7.4) ─────────────────────────────────────────────

/**
 * Реакция воронки на завершение задания кандидатом — в той же транзакции, что и само
 * завершение (`taskCompletion.onTaskCompleted`, единая точка docs/33 D-020).
 *
 * Правила §4.3 и §7.4:
 *   - провал **обязательного** задания → колонка «На перевірці», уведомление рекрутеру,
 *     состояние остаётся `active`: отказ автоматически не ставится ни при каком результате;
 *   - успешное завершение, когда открытых назначений не осталось → «На перевірці» и
 *     «потрібне рішення» рекрутеру;
 *   - успешное завершение, когда что-то ещё открыто → «Проходять».
 *
 * Сотрудника и неактивного кандидата не трогает вовсе: у первого колонок канбана нет, у
 * второго решение уже принято человеком.
 */
export async function syncCandidateStatusTx(
  tx: TenantTx,
  tenantId: string,
  userId: string,
  outcome: 'done' | 'failed',
  assignmentId: string | null,
): Promise<'in_progress' | 'on_review' | null> {
  const [person] = await personById(tx, {
    kind: users.kind,
    state: users.candidateState,
    statusId: users.candidateStatusId,
    recruiterId: users.recruiterId,
    fullName: users.fullName,
  }, userId) as unknown as { kind: string, state: string | null, statusId: string | null, recruiterId: string | null, fullName: string }[]
  if (!person || person.kind !== 'candidate' || person.state !== 'active') return null

  const [open] = await tx.execute(sql`
    select count(*)::int as n
      from enrollments e
     where e.user_id = ${userId}::uuid and e.cancelled_at is null
       and e.status in ('not_started', 'in_progress')`) as unknown as { n: number }[]
  const mandatory = assignmentId
    ? ((await tx.execute(sql`select is_mandatory from assignments where id = ${assignmentId}::uuid`) as unknown as { is_mandatory: boolean }[])[0]?.is_mandatory ?? false)
    : false

  const target = outcome === 'failed'
    ? (mandatory ? 'on_review' : null)
    : (Number(open?.n ?? 0) === 0 ? 'on_review' : 'in_progress')
  if (!target) return null

  const status = await statusByCode(tx, target)
  if (!status || status.id === person.statusId) return null

  await tx.update(users).set({ candidateStatusId: status.id, updatedAt: new Date() })
    .where(and(eq(users.id, userId), candidateOnly()))
  await tx.insert(candidateStatusHistory).values({
    tenantId,
    candidateId: userId,
    fromStatusId: person.statusId,
    toStatusId: status.id,
    reasonCode: outcome === 'failed' ? 'task_failed' : 'task_done',
    actorId: null,
    isAutomatic: true,
    requestContext: null,
  })

  if (target === 'on_review' && person.recruiterId) {
    await enqueueNotification(tx, {
      tenantId,
      userId: person.recruiterId,
      code: outcome === 'failed' ? 'candidate_review_needed' : 'candidate_completed',
      payload: { name: person.fullName },
      dedupKey: `${outcome === 'failed' ? 'candidate_review_needed' : 'candidate_completed'}:${userId}:${new Date().toISOString().slice(0, 10)}`,
      refType: 'user',
      refId: userId,
    })
  }
  return target
}

/** Кандидаты без движения дольше недели — дайджест рекрутеру (§8 `candidate.stale`). */
export async function candidateStaleDigest(tenantId: string): Promise<number> {
  return withTenant(tenantId, null, async (tx) => {
    const rows = await candidatesQuery(tx, { recruiterId: users.recruiterId, n: sql<number>`count(*)::int` }, and(
      eq(users.candidateState, 'active'),
      sql`${users.recruiterId} is not null`,
      sql`${users.candidateStateAt} < now() - interval '7 days'`,
    )).groupBy(users.recruiterId) as unknown as { recruiterId: string | null, n: number }[]
    let sent = 0
    for (const row of rows) {
      if (!row.recruiterId) continue
      const ok = await enqueueNotification(tx, {
        tenantId,
        userId: row.recruiterId,
        code: 'candidate_stale',
        payload: { n: Number(row.n) },
        dedupKey: `candidate_stale:${row.recruiterId}:${new Date().toISOString().slice(0, 10)}`,
      })
      if (ok) sent += 1
    }
    return sent
  })
}
