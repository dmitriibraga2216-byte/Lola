import { sql } from 'drizzle-orm'
import type { SQL } from 'drizzle-orm'
import { withTenant } from '../utils/withTenant'
import type { TenantTx } from '../utils/withTenant'
import { attemptOfSegment, submissionOfSegment, timeConfidence } from '../../shared/domain/learningTime'
import type { LearningTimeClosedReason, LearningTimeKind, ReviewTimeConfidence } from '../../shared/enums'

/**
 * `time.rollup` — свёртка сегментов в витрину и таблицы прогресса (docs/v2/37 §11, §7.12,
 * §7.15; PR-21). «Агрегат фоном»: горячий путь биения пишет только сегменты, всё остальное
 * пересчитывается здесь раз в 10 минут.
 *
 * **Пересчёт, а не приращение.** Для каждой пары «человек × элемент», у которой за окно
 * менялся хоть один сегмент, итоги считаются **заново из всех её сегментов**. Поэтому свёртка
 * идемпотентна (два прогона подряд дают одно и то же), сходится при любых гонках с биениями
 * (пропущенное сейчас изменение попадёт в окно следующего прогона) и сама исправляет то, что
 * меняется задним числом: сегмент, закрытый короче 10 секунд, выбрасывается целиком;
 * `stale` переписывается на `idle_timeout`, когда сеанс вернулся (Р-21.5, Р-21.18).
 *
 * **Что и куда.**
 * - `learning_time_totals` — «человек × элемент × запись на курс», с достоверностью.
 * - `lesson_progress.content_seconds / discarded_seconds / sessions_count` — урок в записи.
 * - `attempts.net_seconds / discarded_seconds` — сегменты попытки привязываются по времени
 *   (Р-21.8): к последней попытке, начатой не позже начала сегмента.
 * - `workshop_submissions.attempt_seconds / content_seconds` — к первой сдаче, отправленной
 *   не раньше начала сегмента, иначе к текущему черновику.
 * - `review_queue_items.content_seconds / attempt_seconds / time_confidence` — «Час на
 *   контент», «Час на випробування» и достоверность работы в очереди проверки (`37` §5.1).
 *
 * **Чего свёртка не трогает никогда.** В `attempts` — ни `deadline_at` (его сдвигает жалоба,
 * PR-23), ни `snapshot` (правило 4), ни `params`, ни `status`, ни `updated_at`: последний —
 * вход 24-часового истечения брошенной попытки (`attempt.expire`), и учёт времени не должен
 * продлевать попытке жизнь. То же — `updated_at` строк прогресса, сдачи и очереди: изменился
 * учёт, а не состояние. Каждая запись — точечный `update … from (values …)` только изменившихся
 * строк (`is distinct from`).
 */

export interface RollupStats {
  pairs: number
  totals: number
  lessonProgress: number
  attempts: number
  submissions: number
  queueItems: number
}

/** Окно по умолчанию — 12 прогонов: сбой задачи на пару часов ничего не теряет (Р-21.18). */
export const ROLLUP_WINDOW_MINUTES = 120
const CHUNK = 200

interface Seg {
  user_id: string
  enrollment_id: string | null
  subject_type: string
  subject_id: string
  kind: LearningTimeKind
  session_key: string
  started_at: Date
  last_beat_at: Date
  closed_reason: LearningTimeClosedReason | null
  credited_seconds: number
  discarded_seconds: number
  is_offline_replay: boolean
}

interface Pair { userId: string, subjectType: string, subjectId: string }

const keyOf = (userId: string, subjectType: string, subjectId: string) => `${userId}|${subjectType}|${subjectId}`

function pushTo<T>(map: Map<string, T[]>, key: string, value: T) {
  const list = map.get(key)
  if (list) list.push(value)
  else map.set(key, [value])
}

function pgArray(values: readonly (string | null)[], type: string): SQL {
  if (!values.length) return sql.raw(`array[]::${type}[]`)
  return sql`array[${sql.join(values.map(v => sql`${v}`), sql`, `)}]::${sql.raw(type)}[]`
}

/** Сводка набора сегментов: секунды по видам, заходы, границы, достоверность. */
function summarize(segs: Seg[]) {
  let content = 0
  let attempt = 0
  let discarded = 0
  let first: Date | null = null
  let last: Date | null = null
  const sessions = new Set<string>()
  for (const s of segs) {
    if (s.kind === 'content') content += s.credited_seconds
    else attempt += s.credited_seconds
    discarded += s.discarded_seconds
    if (s.credited_seconds > 0) {
      sessions.add(s.session_key)
      if (!first || s.started_at < first) first = s.started_at
      if (!last || s.last_beat_at > last) last = s.last_beat_at
    }
  }
  // Отметка отвергнутой старой догрузки — запись о потере, а не оборванный сеанс
  const measured = segs.filter(s => !(s.is_offline_replay && s.closed_reason === 'stale' && s.credited_seconds === 0))
  const confidence: ReviewTimeConfidence = timeConfidence({
    creditedSeconds: content + attempt,
    firstStartedAt: first,
    lastActivityAt: last,
    hasOfflineReplay: segs.some(s => s.is_offline_replay),
    hasDailyCap: segs.some(s => s.closed_reason === 'daily_cap'),
    allStale: measured.length > 0 && measured.every(s => s.closed_reason === 'stale'),
  })
  return { content, attempt, discarded, sessions: sessions.size, first, last, confidence }
}

/**
 * Пары, у которых за окно менялся хоть один сегмент. Окно — по часам базы (`now()`), а не
 * по времени биений: сегмент пишется с `updated_at = now()` той транзакции, что его меняла.
 */
async function dirtyPairs(tx: TenantTx, tenantId: string, windowMinutes: number): Promise<Pair[]> {
  const rows = await tx.execute(sql`
    select distinct user_id, subject_type, subject_id from learning_time_sessions
    where tenant_id = ${tenantId}::uuid and updated_at > now() - make_interval(mins => ${windowMinutes})
  `) as unknown as { user_id: string, subject_type: string, subject_id: string }[]
  return rows.map(r => ({ userId: r.user_id, subjectType: r.subject_type, subjectId: r.subject_id }))
}

/** Свернуть пары одной транзакцией (чанк). */
async function rollupChunk(tx: TenantTx, tenantId: string, pairs: Pair[]): Promise<Omit<RollupStats, 'pairs'>> {
  const stats = { totals: 0, lessonProgress: 0, attempts: 0, submissions: 0, queueItems: 0 }
  const segs = await tx.execute(sql`
    select s.user_id, s.enrollment_id, s.subject_type, s.subject_id, s.kind, s.session_key, s.started_at, s.last_beat_at,
      s.closed_reason, s.credited_seconds, s.discarded_seconds, s.is_offline_replay
    from learning_time_sessions s
    join unnest(${pgArray(pairs.map(p => p.userId), 'uuid')}, ${pgArray(pairs.map(p => p.subjectType), 'text')}, ${pgArray(pairs.map(p => p.subjectId), 'uuid')})
      as p(user_id, subject_type, subject_id)
      on p.user_id = s.user_id and p.subject_type = s.subject_type and p.subject_id = s.subject_id
    where s.tenant_id = ${tenantId}::uuid
  `) as unknown as (Seg & { started_at: string | Date, last_beat_at: string | Date })[]
  for (const s of segs) {
    s.started_at = new Date(s.started_at)
    s.last_beat_at = new Date(s.last_beat_at)
  }
  const byPair = new Map<string, Seg[]>()
  for (const s of segs as Seg[]) {
    const k = keyOf(s.user_id, s.subject_type, s.subject_id)
    const list = byPair.get(k)
    if (list) list.push(s)
    else byPair.set(k, [s])
  }

  // ── 1. Попытки теста (Р-21.8): сначала — их нужны очереди проверки ──────────────────────
  const quizPairs = pairs.filter(p => p.subjectType === 'quiz')
  const attemptRows = quizPairs.length
    ? await tx.execute(sql`
        select a.id, a.user_id, a.quiz_id, a.enrollment_id, a.started_at, a.net_seconds, a.discarded_seconds
        from attempts a
        join unnest(${pgArray(quizPairs.map(p => p.userId), 'uuid')}, ${pgArray(quizPairs.map(p => p.subjectId), 'uuid')}) as p(user_id, quiz_id)
          on p.user_id = a.user_id and p.quiz_id = a.quiz_id
        where a.tenant_id = ${tenantId}::uuid
      `) as unknown as { id: string, user_id: string, quiz_id: string, enrollment_id: string | null, started_at: string | Date, net_seconds: number, discarded_seconds: number }[]
    : []
  /** Сегменты каждой попытки — и выполнения, и чтения условий перед стартом. */
  const segsOfAttempt = new Map<string, Seg[]>()
  const attemptUpdates: { id: string, net: number, discarded: number }[] = []
  for (const p of quizPairs) {
    const mine = attemptRows.filter(a => a.user_id === p.userId && a.quiz_id === p.subjectId)
    const pairSegs = byPair.get(keyOf(p.userId, p.subjectType, p.subjectId)) ?? []
    for (const s of pairSegs) {
      const candidates = mine.filter(a => a.enrollment_id === s.enrollment_id).map(a => ({ id: a.id, startedAt: new Date(a.started_at) }))
      const id = attemptOfSegment(s.kind, s.started_at, candidates)
      if (id) pushTo(segsOfAttempt, id, s)
    }
    for (const a of mine) {
      const own = (segsOfAttempt.get(a.id) ?? []).filter(s => s.kind === 'attempt')
      const net = own.reduce((sum, s) => sum + s.credited_seconds, 0)
      const discarded = own.reduce((sum, s) => sum + s.discarded_seconds, 0)
      if (net !== a.net_seconds || discarded !== a.discarded_seconds) attemptUpdates.push({ id: a.id, net, discarded })
    }
  }
  if (attemptUpdates.length) {
    // Точечно: net_seconds и discarded_seconds. deadline_at, snapshot, params, status и
    // updated_at не трогаются — см. докблок модуля.
    const rows = await tx.execute(sql`
      update attempts a set net_seconds = v.net, discarded_seconds = v.discarded
      from (values ${sql.join(attemptUpdates.map(u => sql`(${u.id}::uuid, ${u.net}::int, ${u.discarded}::int)`), sql`, `)}) as v(id, net, discarded)
      where a.id = v.id and a.tenant_id = ${tenantId}::uuid
        and (a.net_seconds, a.discarded_seconds) is distinct from (v.net, v.discarded)
      returning a.id
    `) as unknown as unknown[]
    stats.attempts = rows.length
  }

  // ── 2. Сдачи практикума (Р-21.8) ────────────────────────────────────────────────────────
  const workshopPairs = pairs.filter(p => p.subjectType === 'workshop')
  const subRows = workshopPairs.length
    ? await tx.execute(sql`
        select w.id, w.user_id, w.workshop_id, w.enrollment_id, w.attempt_no, w.submitted_at, w.attempt_seconds, w.content_seconds
        from workshop_submissions w
        join unnest(${pgArray(workshopPairs.map(p => p.userId), 'uuid')}, ${pgArray(workshopPairs.map(p => p.subjectId), 'uuid')}) as p(user_id, workshop_id)
          on p.user_id = w.user_id and p.workshop_id = w.workshop_id
        where w.tenant_id = ${tenantId}::uuid
      `) as unknown as { id: string, user_id: string, workshop_id: string, enrollment_id: string | null, attempt_no: number, submitted_at: string | Date | null, attempt_seconds: number, content_seconds: number }[]
    : []
  const segsOfSubmission = new Map<string, Seg[]>()
  const subUpdates: { id: string, attempt: number, content: number }[] = []
  for (const p of workshopPairs) {
    const mine = subRows.filter(w => w.user_id === p.userId && w.workshop_id === p.subjectId)
    for (const s of byPair.get(keyOf(p.userId, p.subjectType, p.subjectId)) ?? []) {
      const candidates = mine.filter(w => w.enrollment_id === s.enrollment_id)
        .map(w => ({ id: w.id, attemptNo: w.attempt_no, submittedAt: w.submitted_at ? new Date(w.submitted_at) : null }))
      const id = submissionOfSegment(s.started_at, candidates)
      if (id) pushTo(segsOfSubmission, id, s)
    }
    for (const w of mine) {
      const sum = summarize(segsOfSubmission.get(w.id) ?? [])
      if (sum.attempt !== w.attempt_seconds || sum.content !== w.content_seconds) subUpdates.push({ id: w.id, attempt: sum.attempt, content: sum.content })
    }
  }
  if (subUpdates.length) {
    const rows = await tx.execute(sql`
      update workshop_submissions w set attempt_seconds = v.attempt, content_seconds = v.content
      from (values ${sql.join(subUpdates.map(u => sql`(${u.id}::uuid, ${u.attempt}::int, ${u.content}::int)`), sql`, `)}) as v(id, attempt, content)
      where w.id = v.id and w.tenant_id = ${tenantId}::uuid
        and (w.attempt_seconds, w.content_seconds) is distinct from (v.attempt, v.content)
      returning w.id
    `) as unknown as unknown[]
    stats.submissions = rows.length
  }

  // ── 3. Уроки в записи на курс ───────────────────────────────────────────────────────────
  const lessonPairs = pairs.filter(p => p.subjectType === 'lesson')
  if (lessonPairs.length) {
    const lpRows = await tx.execute(sql`
      select lp.id, lp.enrollment_id, lp.lesson_id, e.user_id, lp.content_seconds, lp.discarded_seconds, lp.sessions_count
      from lesson_progress lp
      join enrollments e on e.id = lp.enrollment_id
      join unnest(${pgArray(lessonPairs.map(p => p.userId), 'uuid')}, ${pgArray(lessonPairs.map(p => p.subjectId), 'uuid')}) as p(user_id, lesson_id)
        on p.user_id = e.user_id and p.lesson_id = lp.lesson_id
      where lp.tenant_id = ${tenantId}::uuid
    `) as unknown as { id: string, enrollment_id: string, lesson_id: string, user_id: string, content_seconds: number, discarded_seconds: number, sessions_count: number }[]
    const lpUpdates: { id: string, content: number, discarded: number, sessions: number }[] = []
    for (const lp of lpRows) {
      const segsOf = (byPair.get(keyOf(lp.user_id, 'lesson', lp.lesson_id)) ?? [])
        .filter(s => s.enrollment_id === lp.enrollment_id && s.kind === 'content')
      const sum = summarize(segsOf)
      if (sum.content !== lp.content_seconds || sum.discarded !== lp.discarded_seconds || sum.sessions !== lp.sessions_count) {
        lpUpdates.push({ id: lp.id, content: sum.content, discarded: sum.discarded, sessions: sum.sessions })
      }
    }
    if (lpUpdates.length) {
      const rows = await tx.execute(sql`
        update lesson_progress lp set content_seconds = v.content, discarded_seconds = v.discarded, sessions_count = v.sessions
        from (values ${sql.join(lpUpdates.map(u => sql`(${u.id}::uuid, ${u.content}::int, ${u.discarded}::int, ${u.sessions}::int)`), sql`, `)}) as v(id, content, discarded, sessions)
        where lp.id = v.id and lp.tenant_id = ${tenantId}::uuid
          and (lp.content_seconds, lp.discarded_seconds, lp.sessions_count) is distinct from (v.content, v.discarded, v.sessions)
        returning lp.id
      `) as unknown as unknown[]
      stats.lessonProgress = rows.length
    }
  }

  // ── 4. Очередь проверки: «Час на контент», «Час на випробування», достоверность ─────────
  const queueUpdates: { id: string, content: number, attempt: number, confidence: ReviewTimeConfidence }[] = []
  const subIds = subRows.map(w => w.id)
  if (subIds.length) {
    const items = await tx.execute(sql`
      select id, source_id, content_seconds, attempt_seconds, time_confidence from review_queue_items
      where tenant_id = ${tenantId}::uuid and task_type = 'workshop' and source_id = any(${pgArray(subIds, 'uuid')})
    `) as unknown as { id: string, source_id: string, content_seconds: number, attempt_seconds: number, time_confidence: string }[]
    for (const q of items) {
      const sum = summarize(segsOfSubmission.get(q.source_id) ?? [])
      if (sum.content !== q.content_seconds || sum.attempt !== q.attempt_seconds || sum.confidence !== q.time_confidence) {
        queueUpdates.push({ id: q.id, content: sum.content, attempt: sum.attempt, confidence: sum.confidence })
      }
    }
  }
  const attemptIds = attemptRows.map(a => a.id)
  if (attemptIds.length) {
    const items = await tx.execute(sql`
      select q.id, aa.attempt_id, q.content_seconds, q.attempt_seconds, q.time_confidence
      from review_queue_items q join attempt_answers aa on aa.id = q.source_id
      where q.tenant_id = ${tenantId}::uuid and q.task_type = 'quiz_open_answer' and aa.attempt_id = any(${pgArray(attemptIds, 'uuid')})
    `) as unknown as { id: string, attempt_id: string, content_seconds: number, attempt_seconds: number, time_confidence: string }[]
    for (const q of items) {
      const sum = summarize(segsOfAttempt.get(q.attempt_id) ?? [])
      if (sum.content !== q.content_seconds || sum.attempt !== q.attempt_seconds || sum.confidence !== q.time_confidence) {
        queueUpdates.push({ id: q.id, content: sum.content, attempt: sum.attempt, confidence: sum.confidence })
      }
    }
  }
  if (queueUpdates.length) {
    const rows = await tx.execute(sql`
      update review_queue_items q set content_seconds = v.content, attempt_seconds = v.attempt, time_confidence = v.confidence
      from (values ${sql.join(queueUpdates.map(u => sql`(${u.id}::uuid, ${u.content}::int, ${u.attempt}::int, ${u.confidence}::text)`), sql`, `)}) as v(id, content, attempt, confidence)
      where q.id = v.id and q.tenant_id = ${tenantId}::uuid
        and (q.content_seconds, q.attempt_seconds, q.time_confidence) is distinct from (v.content, v.attempt, v.confidence)
      returning q.id
    `) as unknown as unknown[]
    stats.queueItems = rows.length
  }

  // ── 5. Витрина «человек × элемент × запись на курс» ────────────────────────────────────
  const groups = new Map<string, { pair: Pair, enrollmentId: string | null, segs: Seg[] }>()
  for (const s of segs as Seg[]) {
    const k = `${keyOf(s.user_id, s.subject_type, s.subject_id)}|${s.enrollment_id ?? ''}`
    const g = groups.get(k) ?? { pair: { userId: s.user_id, subjectType: s.subject_type, subjectId: s.subject_id }, enrollmentId: s.enrollment_id, segs: [] }
    g.segs.push(s)
    groups.set(k, g)
  }
  if (groups.size) {
    const values = [...groups.values()].map((g) => {
      const sum = summarize(g.segs)
      // Границы — по всем сегментам, а не только зачтённым: «первое открытие» бывает и пустым
      const first = new Date(Math.min(...g.segs.map(s => s.started_at.getTime())))
      const last = new Date(Math.max(...g.segs.map(s => s.last_beat_at.getTime())))
      return sql`(${tenantId}::uuid, ${g.pair.userId}::uuid, ${g.enrollmentId}::uuid, ${g.pair.subjectType}::text, ${g.pair.subjectId}::uuid,
        ${sum.confidence}::text, ${sum.content}::int, ${sum.attempt}::int, ${sum.discarded}::int, ${sum.sessions}::int,
        ${first.toISOString()}::timestamptz, ${last.toISOString()}::timestamptz)`
    })
    const rows = await tx.execute(sql`
      insert into learning_time_totals (tenant_id, user_id, enrollment_id, subject_type, subject_id, confidence,
        content_seconds, attempt_seconds, discarded_seconds, sessions_count, first_started_at, last_activity_at)
      values ${sql.join(values, sql`, `)}
      on conflict on constraint uq_learning_time_totals_key do update set
        confidence = excluded.confidence, content_seconds = excluded.content_seconds, attempt_seconds = excluded.attempt_seconds,
        discarded_seconds = excluded.discarded_seconds, sessions_count = excluded.sessions_count,
        first_started_at = excluded.first_started_at, last_activity_at = excluded.last_activity_at, updated_at = now()
      where (learning_time_totals.confidence, learning_time_totals.content_seconds, learning_time_totals.attempt_seconds,
             learning_time_totals.discarded_seconds, learning_time_totals.sessions_count,
             learning_time_totals.first_started_at, learning_time_totals.last_activity_at)
        is distinct from (excluded.confidence, excluded.content_seconds, excluded.attempt_seconds,
             excluded.discarded_seconds, excluded.sessions_count, excluded.first_started_at, excluded.last_activity_at)
      returning id
    `) as unknown as unknown[]
    stats.totals = rows.length
  }
  return stats
}

/**
 * Свёртка тенанта. `windowMinutes` — насколько далеко назад искать изменившиеся сегменты:
 * 120 минут у частого прогона (каждые 10 минут), 48 часов у суточного — он догоняет всё, что
 * частые прогоны могли пропустить, пока задача не работала.
 */
export async function rollupTenant(tenantId: string, opts: { windowMinutes?: number } = {}): Promise<RollupStats> {
  const windowMinutes = opts.windowMinutes ?? ROLLUP_WINDOW_MINUTES
  const pairs = await withTenant(tenantId, null, tx => dirtyPairs(tx, tenantId, windowMinutes))
  const stats: RollupStats = { pairs: pairs.length, totals: 0, lessonProgress: 0, attempts: 0, submissions: 0, queueItems: 0 }
  for (let i = 0; i < pairs.length; i += CHUNK) {
    const chunk = pairs.slice(i, i + CHUNK)
    const s = await withTenant(tenantId, null, tx => rollupChunk(tx, tenantId, chunk))
    stats.totals += s.totals
    stats.lessonProgress += s.lessonProgress
    stats.attempts += s.attempts
    stats.submissions += s.submissions
    stats.queueItems += s.queueItems
  }
  return stats
}
