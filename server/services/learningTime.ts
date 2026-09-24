import { createHash } from 'node:crypto'
import { and, eq, inArray, isNull, sql } from 'drizzle-orm'
import type { SQL } from 'drizzle-orm'
import { enrollments, learningTimeSessions, learningTimeTotals, lessons, quizzes, trajectoryNodes, userPlacements, users, workshops } from '../db/schema'
import { withTenant } from '../utils/withTenant'
import type { TenantTx } from '../utils/withTenant'
import { areaForScope } from './access'
import type { Access } from './access'
import { personById } from './repo/people'
import {
  LEARNING_TIME_RULES as R, applyOnlineBeat, applyReplay, discardReplay, emptyPairState,
} from '../../shared/domain/learningTime'
import type { BeatIn, PairState, TimeSegment } from '../../shared/domain/learningTime'
import type { LearningTimeClosedReason, LearningTimeKind, LearningTimeSubjectType } from '../../shared/enums'
import type {
  BeatInput, BeatResult, BeatsBatchInput, BeatsBatchResult, TimeTotalsQuery, TimeTotalsRow,
} from '../../shared/schemas/learningTime'

/**
 * Учёт времени биениями (docs/v2/37-review-delegation.md §7.10–7.15, §10, §11; PR-21) —
 * единственный писатель `learning_time_sessions`.
 *
 * **Горячий путь — только сегменты.** Биение меняет одну-две строки `learning_time_sessions`
 * и больше ничего: ни `learning_time_totals`, ни `lesson_progress`, ни `attempts`, ни
 * `workshop_submissions` в нём не трогаются — их фоном пересчитывает `time.rollup`
 * (`./learningTimeRollup.ts`). Так биение не спорит за строку попытки ни с сохранением
 * ответа, ни со сдвигом дедлайна по жалобе (PR-23), ни с 24-часовым истечением попытки.
 *
 * **Запись пачками** (решение Р-21.2, `45` §6.1 «Heartbeat как нагрузка»). Онлайн-биения,
 * пришедшие почти одновременно, копятся до 20 мс или до 100 штук и пишутся **одной
 * транзакцией на тенант**, а внутри неё — набором запросов на пачку, а не на биение: блокировки
 * пар одним запросом, состояние одним запросом, агрегаты одним, запись — одной вставкой и
 * одним `update … from (values …)`. 200 одновременных прохождений с выровненными биениями
 * дают несколько транзакций вместо двухсот. Офлайн-пакет (`/learning/time/beats`) — уже пачка:
 * он пишется одной транзакцией целиком и никогда не делится, иначе его части могли бы
 * обогнать друг друга и потерять порядок `seq`.
 *
 * **Конкурентность.** Всё, что меняет сегменты пары «человек × элемент», сериализуется
 * транзакционной advisory-блокировкой пары, взятой в едином порядке (по значению ключа) —
 * две пачки с общими парами не взаимоблокируются. Фоновое закрытие зависших сегментов берёт
 * только незанятые строки (`skip locked`). Инвариант «открытый сегмент у пары один» держит
 * ещё и частичный уникальный индекс.
 *
 * Правила зачёта — в `shared/domain/learningTime.ts`; здесь — загрузка состояния, проверка
 * прав и запись.
 */

export interface TimeCtx { tenantId: string, actorId: string }

export type BeatOutcome
  = | { ok: true, result: BeatResult }
    | { ok: false, code: 'not_found' | 'invalid' }

export type BatchOutcome
  = | { ok: true, result: BeatsBatchResult }
    | { ok: false, code: 'replay_too_old', discarded: number }

/** Биение, отнесённое к человеку и элементу, — единица пачки. */
interface Item {
  userId: string
  subjectType: LearningTimeSubjectType
  subjectId: string
  beat: BeatIn
}

// ── Частота (`37` §10: `429`) ─────────────────────────────────────────────────────────────

/**
 * Предохранитель от зациклившегося клиента, в памяти процесса: 20 биений на человека за
 * 30 секунд (обычно — одно; запас на две вкладки, повтор и последнее биение экрана) и 6
 * офлайн-пакетов в минуту. Счётчик в БД (`rate_limits`) здесь был бы ещё одной записью на
 * каждое биение — ровно та нагрузка, от которой уводит пачечная запись.
 */
const rateWindows = new Map<string, { resetAt: number, used: number }>()

export function allowTimeRequest(key: string, limit: number, windowMs: number, nowMs = Date.now()): boolean {
  if (rateWindows.size > 20_000) {
    for (const [k, w] of rateWindows) if (w.resetAt <= nowMs) rateWindows.delete(k)
  }
  const w = rateWindows.get(key)
  if (!w || w.resetAt <= nowMs) {
    rateWindows.set(key, { resetAt: nowMs + windowMs, used: 1 })
    return true
  }
  w.used += 1
  return w.used <= limit
}

export const BEAT_RATE = { limit: 20, windowMs: 30_000 } as const
export const REPLAY_RATE = { limit: 6, windowMs: 60_000 } as const

// ── Разбор ────────────────────────────────────────────────────────────────────────────────

function toBeat(b: BeatInput, at: Date): BeatIn {
  return {
    sessionKey: b.sessionKey,
    seq: b.seq,
    kind: b.kind,
    enrollmentId: b.enrollmentId ?? null,
    activeMs: b.activeMs,
    visible: b.visible,
    resume: b.resume === true,
    end: b.end === true,
    device: b.device ?? null,
    at,
  }
}

const pairKey = (i: { userId: string, subjectType: string, subjectId: string }) => `${i.userId}|${i.subjectType}|${i.subjectId}`

/** 63-битный ключ advisory-блокировки пары — одинаковый во всех процессах приложения. */
function lockKeyOf(tenantId: string, key: string): bigint {
  const digest = createHash('sha256').update(`lts|${tenantId}|${key}`).digest()
  return BigInt.asIntN(64, digest.readBigUInt64BE(0))
}

function pgArray(values: readonly (string | number | Date | null)[], type: string): SQL {
  if (!values.length) return sql.raw(`array[]::${type}[]`)
  return sql`array[${sql.join(values.map(v => sql`${v instanceof Date ? v.toISOString() : v}`), sql`, `)}]::${sql.raw(type)}[]`
}

// ── Состояние пар ─────────────────────────────────────────────────────────────────────────

interface SegRow {
  id: string
  user_id: string
  enrollment_id: string | null
  subject_type: string
  subject_id: string
  kind: LearningTimeKind
  session_key: string
  segment_no: number
  beats_count: number
  started_at: string | Date
  last_beat_at: string | Date
  closed_reason: LearningTimeClosedReason | null
  credited_seconds: number
  discarded_seconds: number
  media_seconds: number
  last_seq: number
  last_credit: number
  device: string | null
  is_offline_replay: boolean
}

function segmentOf(r: SegRow): TimeSegment {
  return {
    id: r.id,
    sessionKey: r.session_key,
    segmentNo: r.segment_no,
    kind: r.kind,
    enrollmentId: r.enrollment_id,
    startedAt: new Date(r.started_at),
    lastBeatAt: new Date(r.last_beat_at),
    beatsCount: r.beats_count,
    creditedSeconds: r.credited_seconds,
    discardedSeconds: r.discarded_seconds,
    mediaSeconds: r.media_seconds,
    closedReason: r.closed_reason,
    isOfflineReplay: r.is_offline_replay,
    lastSeq: r.last_seq,
    lastCredit: r.last_credit,
    device: r.device,
    dirty: false,
  }
}

interface Loaded {
  pairs: Map<string, PairState>
  /** Сеансы, последний сегмент которых принадлежит другой паре (чужой человек или элемент). */
  foreignKeys: Set<string>
  /** Сеансы, уже известные базе: у новых проверяется элемент и запись на курс. */
  knownKeys: Set<string>
}

/**
 * Блокировки и состояние всех пар пачки. Блокировки — **до** чтения: в READ COMMITTED каждый
 * запрос видит всё, что закоммичено к его началу, значит состояние читается уже после того,
 * как соседняя пачка с теми же парами закончила.
 */
async function loadPairs(tx: TenantTx, tenantId: string, items: Item[], needMedia: Set<string>): Promise<Loaded> {
  const specs = new Map<string, { userId: string, subjectType: string, subjectId: string, now: Date }>()
  for (const i of items) {
    const k = pairKey(i)
    const s = specs.get(k)
    if (!s) specs.set(k, { userId: i.userId, subjectType: i.subjectType, subjectId: i.subjectId, now: i.beat.at })
    else if (i.beat.at > s.now) s.now = i.beat.at
  }
  const keys = [...specs.keys()]
  const lockKeys = keys.map(k => lockKeyOf(tenantId, k)).sort((a, b) => (a < b ? -1 : a > b ? 1 : 0))
  await tx.execute(sql`select pg_advisory_xact_lock(k) from unnest(${pgArray(lockKeys.map(String), 'bigint')}) as t(k)`)

  const users = keys.map(k => specs.get(k)!.userId)
  const types = keys.map(k => specs.get(k)!.subjectType)
  const subjects = keys.map(k => specs.get(k)!.subjectId)
  const sessionKeys = [...new Set(items.map(i => i.beat.sessionKey))]

  // Два запроса, а не один с `or`: каждый идёт своим индексом — последний сегмент сеанса по
  // `uq_learning_time_sessions_segment`, открытый сегмент пары по `uq_…_open_pair`. Таблица
  // копит сегменты 400 дней, и `or` между ними обернулся бы полным просмотром тенанта на
  // каждую пачку. Оба — после блокировок пар, поэтому видят одно и то же состояние.
  const latestRows = await tx.execute(sql`
    select s.* from learning_time_sessions s
    join (
      select session_key, max(segment_no) as segment_no from learning_time_sessions
      where tenant_id = ${tenantId}::uuid and session_key = any(${pgArray(sessionKeys, 'uuid')})
      group by session_key
    ) m on m.session_key = s.session_key and m.segment_no = s.segment_no
    where s.tenant_id = ${tenantId}::uuid
    for update of s
  `) as unknown as SegRow[]
  const openRows = await tx.execute(sql`
    select s.* from learning_time_sessions s
    join unnest(${pgArray(users, 'uuid')}, ${pgArray(types, 'text')}, ${pgArray(subjects, 'uuid')}) as p(user_id, subject_type, subject_id)
      on p.user_id = s.user_id and p.subject_type = s.subject_type and p.subject_id = s.subject_id
    where s.tenant_id = ${tenantId}::uuid and s.closed_reason is null
    for update of s
  `) as unknown as SegRow[]
  const seen = new Set<string>()
  const rows = [...latestRows, ...openRows].filter(r => (seen.has(r.id) ? false : (seen.add(r.id), true)))

  const aggs = await tx.execute(sql`
    select s.user_id, s.subject_type, s.subject_id,
      max(s.last_beat_at) filter (where not s.is_offline_replay) as last_online,
      coalesce(sum(s.credited_seconds) filter (where s.kind = 'content' and s.last_beat_at > p.now - make_interval(secs => ${R.dailyWindowSec})), 0)::int as daily_content,
      coalesce(sum(s.credited_seconds) filter (where s.kind = 'attempt' and s.last_beat_at > p.now - make_interval(secs => ${R.dailyWindowSec})), 0)::int as daily_attempt,
      coalesce(sum(s.media_seconds), 0)::int as media_used
    from learning_time_sessions s
    join unnest(${pgArray(users, 'uuid')}, ${pgArray(types, 'text')}, ${pgArray(subjects, 'uuid')}, ${pgArray(keys.map(k => specs.get(k)!.now), 'timestamptz')})
      as p(user_id, subject_type, subject_id, now)
      on p.user_id = s.user_id and p.subject_type = s.subject_type and p.subject_id = s.subject_id
    where s.tenant_id = ${tenantId}::uuid
    group by s.user_id, s.subject_type, s.subject_id, p.now
  `) as unknown as { user_id: string, subject_type: string, subject_id: string, last_online: string | Date | null, daily_content: number, daily_attempt: number, media_used: number }[]

  const pairs = new Map<string, PairState>()
  for (const k of keys) pairs.set(k, emptyPairState())
  for (const a of aggs) {
    const p = pairs.get(pairKey({ userId: a.user_id, subjectType: a.subject_type, subjectId: a.subject_id }))
    if (!p) continue
    p.lastOnlineBeatAt = a.last_online ? new Date(a.last_online) : null
    p.daily = { content: a.daily_content, attempt: a.daily_attempt }
    p.mediaUsed = a.media_used
  }

  const foreignKeys = new Set<string>()
  const knownKeys = new Set<string>()
  const batchKeys = new Set(sessionKeys)
  for (const r of rows) {
    const k = pairKey({ userId: r.user_id, subjectType: r.subject_type, subjectId: r.subject_id })
    const p = pairs.get(k)
    if (batchKeys.has(r.session_key)) knownKeys.add(r.session_key)
    if (!p) {
      // Сеанс пачки, чей сегмент принадлежит другой паре: другой человек, другой элемент —
      // протокол нарушен, писать в чужой сегмент нельзя ни при каком раскладе
      if (batchKeys.has(r.session_key)) foreignKeys.add(r.session_key)
      continue
    }
    const seg = segmentOf(r)
    const cur = p.latest.get(r.session_key)
    if (!cur || cur.segmentNo < seg.segmentNo) p.latest.set(r.session_key, seg)
  }

  if (needMedia.size) {
    const caps = await mediaCaps(tx, [...needMedia])
    for (const [k, p] of pairs) {
      const spec = specs.get(k)!
      if (spec.subjectType === 'lesson') p.mediaCapSec = caps.get(spec.subjectId) ?? null
    }
  }
  return { pairs, foreignKeys, knownKeys }
}

/**
 * Потолок медиа урока (`37` §7.11 «Фоновая вкладка»): 1,5 × суммарная длина видео и аудио
 * материала — самого ресурса и видеоблоков статьи, в версии, закреплённой публикацией курса.
 * Длина неизвестна (файл ещё не обработан) — потолка нет, и скрытая вкладка не засчитывается.
 */
async function mediaCaps(tx: TenantTx, lessonIds: string[]): Promise<Map<string, number | null>> {
  const rows = await tx.execute(sql`
    select l.id as lesson_id, coalesce(rv.media_id, r.media_id) as media_id, coalesce(rv.body, r.body) as body
    from lessons l
    join resources r on r.id = l.item_id and l.item_type = 'resource'
    left join resource_versions rv on rv.id = coalesce(l.resource_version_id, r.published_version_id)
    where l.id = any(${pgArray(lessonIds, 'uuid')})
  `) as unknown as { lesson_id: string, media_id: string | null, body: unknown }[]
  const mediaOf = new Map<string, string[]>()
  for (const r of rows) {
    const ids = r.media_id ? [r.media_id] : []
    for (const b of (Array.isArray(r.body) ? r.body : []) as { type?: string, mediaId?: string }[]) {
      if (b.type === 'video' && typeof b.mediaId === 'string') ids.push(b.mediaId)
    }
    mediaOf.set(r.lesson_id, ids)
  }
  const all = [...new Set([...mediaOf.values()].flat())]
  const durations = new Map<string, number>()
  if (all.length) {
    const media = await tx.execute(sql`
      select id, duration_sec from media_assets
      where id = any(${pgArray(all, 'uuid')}) and kind in ('video', 'audio') and duration_sec > 0
    `) as unknown as { id: string, duration_sec: number }[]
    for (const m of media) durations.set(m.id, m.duration_sec)
  }
  const caps = new Map<string, number | null>()
  for (const id of lessonIds) {
    const total = (mediaOf.get(id) ?? []).reduce((s, m) => s + (durations.get(m) ?? 0), 0)
    caps.set(id, total > 0 ? Math.floor(total * R.mediaFactor) : null)
  }
  return caps
}

/**
 * Новый сеанс ссылается на существующий элемент своего тенанта и на свою запись на курс.
 * Проверка — один раз, на первом биении сеанса: дальше сеанс уже принадлежит паре.
 * Чужой тенант и чужая запись — «не найдено», а не «запрещено» (CLAUDE.md п. 15).
 */
async function validSubjects(tx: TenantTx, items: Item[]): Promise<{ subjects: Set<string>, enrollmentOwner: Map<string, string> }> {
  const want = new Map<LearningTimeSubjectType, Set<string>>()
  for (const i of items) want.set(i.subjectType, (want.get(i.subjectType) ?? new Set()).add(i.subjectId))
  const subjects = new Set<string>()
  const add = (type: string, rows: { id: string }[]) => rows.forEach(r => subjects.add(`${type}:${r.id}`))
  for (const [type, set] of want) {
    const ids = [...set]
    if (type === 'lesson') add(type, await tx.select({ id: lessons.id }).from(lessons).where(inArray(lessons.id, ids)))
    else if (type === 'quiz') add(type, await tx.select({ id: quizzes.id }).from(quizzes).where(and(inArray(quizzes.id, ids), isNull(quizzes.deletedAt))))
    else if (type === 'workshop') add(type, await tx.select({ id: workshops.id }).from(workshops).where(and(inArray(workshops.id, ids), isNull(workshops.deletedAt))))
    else add(type, await tx.select({ id: trajectoryNodes.id }).from(trajectoryNodes).where(inArray(trajectoryNodes.id, ids)))
  }
  const enrollmentIds = [...new Set(items.map(i => i.beat.enrollmentId).filter((x): x is string => !!x))]
  const enrollmentOwner = new Map<string, string>()
  if (enrollmentIds.length) {
    const rows = await tx.select({ id: enrollments.id, userId: enrollments.userId }).from(enrollments).where(inArray(enrollments.id, enrollmentIds))
    for (const r of rows) enrollmentOwner.set(r.id, r.userId)
  }
  return { subjects, enrollmentOwner }
}

// ── Запись ────────────────────────────────────────────────────────────────────────────────

/**
 * Записать изменённые сегменты: сначала обновления (они закрывают старые открытые
 * сегменты), затем вставки новых — иначе частичный уникальный индекс «один открытый на пару»
 * увидел бы два открытых сразу. Каждое — одним запросом на всю пачку.
 */
async function persist(tx: TenantTx, tenantId: string, owners: Map<TimeSegment, Item>, touched: TimeSegment[]) {
  const updates = touched.filter(s => s.id !== null)
  const inserts = touched.filter(s => s.id === null)
  if (updates.length) {
    const values = sql.join(updates.map(s => sql`(${s.id}::uuid, ${s.lastBeatAt.toISOString()}::timestamptz, ${s.beatsCount}::int,
      ${s.creditedSeconds}::int, ${s.discardedSeconds}::int, ${s.mediaSeconds}::int, ${s.closedReason}::text,
      ${s.lastSeq}::int, ${s.lastCredit}::int)`), sql`, `)
    await tx.execute(sql`
      update learning_time_sessions s set
        last_beat_at = v.last_beat_at, beats_count = v.beats_count, credited_seconds = v.credited,
        discarded_seconds = v.discarded, media_seconds = v.media, closed_reason = v.closed_reason,
        last_seq = v.last_seq, last_credit = v.last_credit, updated_at = now()
      from (values ${values}) as v(id, last_beat_at, beats_count, credited, discarded, media, closed_reason, last_seq, last_credit)
      where s.id = v.id and s.tenant_id = ${tenantId}::uuid
    `)
  }
  if (inserts.length) {
    const created = await tx.insert(learningTimeSessions).values(inserts.map((s) => {
      const owner = owners.get(s)!
      return {
        tenantId,
        userId: owner.userId,
        enrollmentId: s.enrollmentId,
        subjectType: owner.subjectType,
        subjectId: owner.subjectId,
        kind: s.kind,
        sessionKey: s.sessionKey,
        segmentNo: s.segmentNo,
        beatsCount: s.beatsCount,
        startedAt: s.startedAt,
        lastBeatAt: s.lastBeatAt,
        closedReason: s.closedReason,
        creditedSeconds: s.creditedSeconds,
        discardedSeconds: s.discardedSeconds,
        mediaSeconds: s.mediaSeconds,
        lastSeq: s.lastSeq,
        lastCredit: s.lastCredit,
        device: s.device,
        isOfflineReplay: s.isOfflineReplay,
      }
    })).returning({ id: learningTimeSessions.id, sessionKey: learningTimeSessions.sessionKey, segmentNo: learningTimeSessions.segmentNo })
    const idOf = new Map(created.map(c => [`${c.sessionKey}#${c.segmentNo}`, c.id]))
    for (const s of inserts) s.id = idOf.get(`${s.sessionKey}#${s.segmentNo}`) ?? null
  }
  for (const s of touched) s.dirty = false
}

/** Какой паре принадлежит сегмент — для вставки (в самом сегменте пары нет, она — ключ карты). */
function ownersOf(itemsByPair: Map<string, Item[]>, pairs: Map<string, PairState>): Map<TimeSegment, Item> {
  const owners = new Map<TimeSegment, Item>()
  for (const [k, p] of pairs) {
    const first = itemsByPair.get(k)?.[0]
    if (!first) continue
    for (const s of p.touched) owners.set(s, first)
  }
  return owners
}

// ── Онлайн-биения: групповая фиксация ────────────────────────────────────────────────────

function resultOf(o: ReturnType<typeof applyOnlineBeat>): BeatResult {
  return { credited: o.credited, dailyLeft: o.dailyLeft, segmentNo: o.segmentNo, capped: o.capped, stillHere: o.stillHere, duplicate: o.duplicate }
}

/**
 * Одна транзакция на пачку онлайн-биений тенанта. Биения одной пары применяются в порядке
 * прихода (время сервера), разные пары независимы.
 */
export async function writeOnlineBatch(tenantId: string, items: Item[]): Promise<BeatOutcome[]> {
  return withTenant(tenantId, null, async (tx) => {
    const needMedia = new Set(items.filter(i => !i.beat.visible && i.subjectType === 'lesson' && i.beat.kind === 'content').map(i => i.subjectId))
    const { pairs, foreignKeys, knownKeys } = await loadPairs(tx, tenantId, items, needMedia)
    const fresh = items.filter(i => !knownKeys.has(i.beat.sessionKey))
    const { subjects, enrollmentOwner } = fresh.length ? await validSubjects(tx, fresh) : { subjects: new Set<string>(), enrollmentOwner: new Map<string, string>() }

    const outcomes: BeatOutcome[] = Array.from({ length: items.length })
    const order = items.map((item, idx) => ({ item, idx }))
      .sort((a, b) => a.item.beat.at.getTime() - b.item.beat.at.getTime() || a.item.beat.seq - b.item.beat.seq)
    const itemsByPair = new Map<string, Item[]>()
    for (const { item, idx } of order) {
      const b = item.beat
      if (foreignKeys.has(b.sessionKey)) { outcomes[idx] = { ok: false, code: 'invalid' }; continue }
      if (!knownKeys.has(b.sessionKey)) {
        if (!subjects.has(`${item.subjectType}:${item.subjectId}`)) { outcomes[idx] = { ok: false, code: 'not_found' }; continue }
        if (b.enrollmentId && enrollmentOwner.get(b.enrollmentId) !== item.userId) { outcomes[idx] = { ok: false, code: 'not_found' }; continue }
      }
      const k = pairKey(item)
      const list = itemsByPair.get(k)
      if (list) list.push(item)
      else itemsByPair.set(k, [item])
      const o = applyOnlineBeat(pairs.get(k)!, b)
      outcomes[idx] = o.invalid ? { ok: false, code: 'invalid' } : { ok: true, result: resultOf(o) }
    }

    const touched = [...pairs.values()].flatMap(p => p.touched)
    await persist(tx, tenantId, ownersOf(itemsByPair, pairs), touched)
    return outcomes
  })
}

/** Счётчики групповой фиксации — для нагрузочной проверки и метрик. */
export const beatWriterStats = { batches: 0, beats: 0, fallbacks: 0, maxBatch: 0 }

export const BATCH_WINDOW_MS = 20
export const BATCH_MAX = 100

interface Job { item: Item, resolve: (o: BeatOutcome) => void, reject: (e: unknown) => void }
const pending = new Map<string, Job[]>()
const timers = new Map<string, ReturnType<typeof setTimeout>>()

async function runBatch(tenantId: string, jobs: Job[]) {
  beatWriterStats.batches += 1
  beatWriterStats.beats += jobs.length
  beatWriterStats.maxBatch = Math.max(beatWriterStats.maxBatch, jobs.length)
  try {
    const out = await writeOnlineBatch(tenantId, jobs.map(j => j.item))
    jobs.forEach((j, i) => j.resolve(out[i]!))
  }
  catch (err) {
    if (jobs.length === 1) {
      jobs[0]!.reject(err)
      return
    }
    // Одно ядовитое биение не должно ронять соседей: пачка разбирается поштучно
    beatWriterStats.fallbacks += 1
    for (const j of jobs) {
      try { j.resolve((await writeOnlineBatch(tenantId, [j.item]))[0]!) }
      catch (e) { j.reject(e) }
    }
  }
}

function flush(tenantId: string) {
  const t = timers.get(tenantId)
  if (t) clearTimeout(t)
  timers.delete(tenantId)
  const jobs = pending.get(tenantId) ?? []
  pending.delete(tenantId)
  if (jobs.length) void runBatch(tenantId, jobs)
}

function enqueueBeat(tenantId: string, item: Item): Promise<BeatOutcome> {
  return new Promise((resolve, reject) => {
    const jobs = pending.get(tenantId) ?? []
    jobs.push({ item, resolve, reject })
    pending.set(tenantId, jobs)
    if (jobs.length >= BATCH_MAX) flush(tenantId)
    else if (!timers.has(tenantId)) timers.set(tenantId, setTimeout(() => flush(tenantId), BATCH_WINDOW_MS))
  })
}

/**
 * `POST /learning/time/beat` (`37` §10). Время приёма фиксируется **здесь**, до ожидания
 * пачки: зачёт считается по моменту, когда биение пришло, а не когда его записали.
 * `opts.now` — только для тестов (симуляция 30-секундных интервалов без ожидания).
 */
export async function recordBeat(ctx: TimeCtx, input: BeatInput, opts: { now?: Date } = {}): Promise<BeatOutcome> {
  const at = opts.now ?? new Date()
  return enqueueBeat(ctx.tenantId, { userId: ctx.actorId, subjectType: input.subjectType, subjectId: input.subjectId, beat: toBeat(input, at) })
}

// ── Офлайн-догрузка ───────────────────────────────────────────────────────────────────────

/**
 * `POST /learning/time/beats` (`37` §7.11 «Потеря связи», §10). Время биения — `clientTs`,
 * исправленный на сдвиг часов клиента: `sentAt` пакета против серверного «сейчас» (Р-21.13);
 * будущее обрезается до «сейчас». Пакет, чьё старейшее биение старше 24 часов, не
 * принимается — его время уходит в выброшенное, и ответ `422 time.replay_too_old`.
 */
export async function recordBeats(ctx: TimeCtx, input: BeatsBatchInput, opts: { now?: Date } = {}): Promise<BatchOutcome> {
  const now = opts.now ?? new Date()
  const offsetMs = input.sentAt ? now.getTime() - Date.parse(input.sentAt) : 0
  const items: Item[] = input.beats.map(b => ({
    userId: ctx.actorId,
    subjectType: b.subjectType,
    subjectId: b.subjectId,
    beat: toBeat(b, new Date(Math.min(now.getTime(), Date.parse(b.clientTs) + offsetMs))),
  }))
  const oldest = Math.min(...items.map(i => i.beat.at.getTime()))
  const tooOld = oldest < now.getTime() - R.replayMaxAgeSec * 1000

  return withTenant(ctx.tenantId, ctx.actorId, async (tx): Promise<BatchOutcome> => {
    const needMedia = new Set(items.filter(i => !i.beat.visible && i.subjectType === 'lesson' && i.beat.kind === 'content').map(i => i.subjectId))
    const { pairs, foreignKeys, knownKeys } = await loadPairs(tx, ctx.tenantId, items, needMedia)
    const fresh = items.filter(i => !knownKeys.has(i.beat.sessionKey))
    const { subjects, enrollmentOwner } = fresh.length ? await validSubjects(tx, fresh) : { subjects: new Set<string>(), enrollmentOwner: new Map<string, string>() }

    // Чужие и несуществующие отбрасываются поштучно: пакет с телефона не должен пропасть
    // целиком из-за одного урока, который успели удалить, пока человек был без связи
    const itemsByPair = new Map<string, Item[]>()
    let rejected = 0
    for (const i of items) {
      const b = i.beat
      const bad = foreignKeys.has(b.sessionKey)
        || (!knownKeys.has(b.sessionKey) && (!subjects.has(`${i.subjectType}:${i.subjectId}`)
          || (!!b.enrollmentId && enrollmentOwner.get(b.enrollmentId) !== i.userId)))
      if (bad) { rejected++; continue }
      const k = pairKey(i)
      const list = itemsByPair.get(k)
      if (list) list.push(i)
      else itemsByPair.set(k, [i])
    }

    const sum: BeatsBatchResult = { credited: 0, discarded: 0, accepted: 0, duplicates: 0, rejected, stillHere: false }
    let lost = 0
    for (const [k, list] of itemsByPair) {
      const pair = pairs.get(k)!
      if (tooOld) lost += discardReplay(pair, list.map(i => i.beat))
      else {
        const r = applyReplay(pair, list.map(i => i.beat))
        sum.credited += r.credited
        sum.discarded += r.discarded
        sum.accepted += r.accepted
        sum.duplicates += r.duplicates
        sum.stillHere ||= r.stillHere
      }
    }
    const touched = [...pairs.values()].flatMap(p => p.touched)
    await persist(tx, ctx.tenantId, ownersOf(itemsByPair, pairs), touched)
    if (tooOld) return { ok: false, code: 'replay_too_old', discarded: lost }
    return { ok: true, result: sum }
  })
}

// ── Закрытие сегментов ────────────────────────────────────────────────────────────────────

/**
 * Одно выражение закрытия для SQL: сегмент короче 10 секунд отбрасывается целиком (`37`
 * §7.11) — так же, как `closeSegment()` в памяти. В `set` все выражения видят старую строку.
 */
const closeSet = (reason: LearningTimeClosedReason) => sql`
  closed_reason = ${reason},
  discarded_seconds = discarded_seconds + case when credited_seconds < ${R.minSegmentSec} then credited_seconds else 0 end,
  credited_seconds = case when credited_seconds < ${R.minSegmentSec} then 0 else credited_seconds end,
  media_seconds = case when credited_seconds < ${R.minSegmentSec} then 0 else media_seconds end,
  updated_at = now()`

/**
 * `time.close_stale_sessions` (`37` §11, каждые 5 минут): сегменты без биений дольше 120 с
 * закрываются `stale` — «аварийное завершение»; зачтено остаётся пришедшее, задним числом
 * ничего не достраивается. Строки, которые сейчас пишет пачка, пропускаются (`skip locked`):
 * пачка продлит их сама, а не продлённые закроет следующий проход.
 */
export async function closeStaleSessions(tenantId: string, opts: { now?: Date } = {}): Promise<number> {
  const now = opts.now ?? new Date()
  return withTenant(tenantId, null, async (tx) => {
    const rows = await tx.execute(sql`
      with s as (
        select id from learning_time_sessions
        where tenant_id = ${tenantId}::uuid and closed_reason is null
          and last_beat_at < ${now.toISOString()}::timestamptz - make_interval(secs => ${R.idleTimeoutSec})
        for update skip locked
      )
      update learning_time_sessions l set ${closeSet('stale')}
      from s where l.id = s.id
      returning l.id
    `) as unknown as { id: string }[]
    return rows.length
  })
}

/**
 * Элемент завершён — открытые сегменты пары закрываются `completed` (`37` §3.6): урок зачтён,
 * попытка отправлена или истекла, практикум сдан. Вызывается в транзакции самого события и
 * заодно отмечает пару «изменившейся» для свёртки — время попадает в попытку и в очередь
 * проверки ближайшим проходом `time.rollup`. Сегментов нет — ничего не делает.
 */
export async function closeOpenSegments(tx: TenantTx, input: { tenantId: string, userId: string, subjectType: LearningTimeSubjectType, subjectId: string, reason?: LearningTimeClosedReason }): Promise<number> {
  const rows = await tx.execute(sql`
    update learning_time_sessions set ${closeSet(input.reason ?? 'completed')}
    where tenant_id = ${input.tenantId}::uuid and user_id = ${input.userId}::uuid
      and subject_type = ${input.subjectType} and subject_id = ${input.subjectId}::uuid and closed_reason is null
    returning id
  `) as unknown as { id: string }[]
  return rows.length
}

// ── Чтение ────────────────────────────────────────────────────────────────────────────────

export type TotalsOutcome = { ok: true, rows: TimeTotalsRow[] } | { ok: false, code: 'not_found' | 'forbidden' }

/**
 * `GET /learning/time/totals` (`37` §2, §10). Своё время видит каждый. Чужое — носитель
 * `time.metrics.view` в своей области: наставник и руководитель — людей своей точки,
 * администратор — всех (область — по основной точке человека). Автор материала поимённых
 * цифр не получает — ему обезличенный отчёт PR-22 (`37` §7.14 (в)). Чужой тенант и
 * несуществующий человек — 404 (CLAUDE.md п. 15).
 */
export async function timeTotals(access: Access, q: TimeTotalsQuery): Promise<TotalsOutcome> {
  const target = q.userId ?? access.userId
  return withTenant(access.tenantId, access.userId, async (tx): Promise<TotalsOutcome> => {
    if (target !== access.userId) {
      const [person] = await personById(tx, { id: users.id }, target)
      if (!person) return { ok: false, code: 'not_found' }
      const area = await areaForScope(access, 'time.metrics.view')
      if (area !== null) {
        const [pl] = await tx.select({ locationId: userPlacements.locationId }).from(userPlacements)
          .where(and(eq(userPlacements.userId, target), eq(userPlacements.isPrimary, true), isNull(userPlacements.endedAt)))
        if (!pl?.locationId || !area.includes(pl.locationId)) return { ok: false, code: 'forbidden' }
      }
    }
    const rows = await tx.select().from(learningTimeTotals).where(and(
      eq(learningTimeTotals.userId, target),
      ...(q.subjectType ? [eq(learningTimeTotals.subjectType, q.subjectType)] : []),
      ...(q.subjectId ? [eq(learningTimeTotals.subjectId, q.subjectId)] : []),
      ...(q.enrollmentId ? [eq(learningTimeTotals.enrollmentId, q.enrollmentId)] : []),
    )).orderBy(sql`${learningTimeTotals.lastActivityAt} desc nulls last`).limit(500)
    return {
      ok: true,
      rows: rows.map(r => ({
        userId: r.userId,
        enrollmentId: r.enrollmentId,
        subjectType: r.subjectType as LearningTimeSubjectType,
        subjectId: r.subjectId,
        contentSeconds: r.contentSeconds,
        attemptSeconds: r.attemptSeconds,
        discardedSeconds: r.discardedSeconds,
        sessionsCount: r.sessionsCount,
        confidence: r.confidence as TimeTotalsRow['confidence'],
        firstStartedAt: r.firstStartedAt?.toISOString() ?? null,
        lastActivityAt: r.lastActivityAt?.toISOString() ?? null,
      })),
    }
  })
}
