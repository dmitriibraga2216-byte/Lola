import type { LearningTimeClosedReason, LearningTimeKind, ReviewTimeConfidence } from '../enums'

/**
 * Учёт времени биениями — правила в чистом виде (docs/v2/37-review-delegation.md §7.10–7.15,
 * PR-21). Один источник порогов для сервера (`server/services/learningTime*.ts`), экрана
 * (`app/composables/useLearningTime.ts`) и тестов.
 *
 * **Время считается биениями, а не разницей «открыл — закрыл»** (сквозная проверка 22,
 * `docs/v2/42` §5). Экран каждые 30 секунд сообщает, сколько миллисекунд из них человек был
 * активен; сервер зачитывает за биение
 *
 *     credit = min(active_ms / 1000, server_now − prev_beat_server_ts, 30)
 *
 * и дополнительно не больше, чем прошло по серверным часам с последнего биения той же пары
 * «человек × элемент» на любом устройстве (решение Р-21.3: два устройства суммируются, но
 * одновременная работа не даёт больше реального времени — `docs/03` §41).
 *
 * Модуль не знает о базе: сервис загружает состояние пары, прогоняет через него биения и
 * пишет изменившиеся сегменты одной пачкой. Отсюда же и тестируемость: правила проверяются
 * без БД (`tests/unit/learning-time.spec.ts`), а интеграционные тесты проверяют, что сервис
 * пишет ровно то, что посчитал модуль.
 */
export const LEARNING_TIME_RULES = {
  /** Интервал биения: максимальная ошибка — 30 с на сеанс (`37` §7.11). */
  beatIntervalSec: 30,
  /** Порог неактивности: 4 пропущенных биения — пауза не засчитывается, новый сегмент. */
  idleTimeoutSec: 120,
  /** Потолок сегмента 90 минут: «Ви ще тут?», время стоит до «Продовжити». */
  segmentCapSec: 5400,
  /** Потолок суток — рабочая смена, на связку «человек × элемент × вид». Сутки — скользящие 24 часа (Р-21.6). */
  dailyCapSec: 28_800,
  dailyWindowSec: 86_400,
  /** Сегмент короче 10 секунд — случайное открытие, отбрасывается целиком. */
  minSegmentSec: 10,
  /** Офлайн-буфер клиента: 200 биений = 100 минут. */
  offlineBufferMax: 200,
  /** Догрузка старше 24 часов не принимается, её время пишется в выброшенное. */
  replayMaxAgeSec: 86_400,
  /** Скрытая вкладка с воспроизведением медиа: суммарно не более 1,5 × длины медиа. */
  mediaFactor: 1.5,
  /**
   * Клиент: сколько после последнего события (движение, клавиша, прокрутка, касание, кадр
   * видео) человек считается активным. Чтение абзаца без движения мыши — это внимание, а не
   * простой; 15 секунд — половина интервала биения.
   */
  activeWindowMs: 15_000,
  /** Достоверность (`37` §7.15): покрытие ≥ 80 % — ok, 40–79 % — partial, ниже — unreliable. */
  okCoverage: 0.8,
  partialCoverage: 0.4,
} as const

const R = LEARNING_TIME_RULES

// ── Состояние ─────────────────────────────────────────────────────────────────────────────

/** Сегмент в памяти — зеркало строки `learning_time_sessions`. `id = null` — ещё не записан. */
export interface TimeSegment {
  id: string | null
  sessionKey: string
  segmentNo: number
  kind: LearningTimeKind
  enrollmentId: string | null
  startedAt: Date
  lastBeatAt: Date
  beatsCount: number
  creditedSeconds: number
  discardedSeconds: number
  mediaSeconds: number
  closedReason: LearningTimeClosedReason | null
  isOfflineReplay: boolean
  lastSeq: number
  lastCredit: number
  device: string | null
  /** Изменён в этом прогоне — его нужно записать. */
  dirty: boolean
}

/**
 * Всё, что нужно знать о паре «человек × элемент», чтобы применить к ней биения. Пара — а не
 * сеанс — потому что правила пересекают сеансы: открытый сегмент у пары один (`37` §4), бюджет
 * реального времени общий на все устройства (Р-21.3), суточный потолок — на пару и вид.
 */
export interface PairState {
  /** Последний сегмент каждого известного сеанса пары; открытый сегмент сеанса — всегда последний. */
  latest: Map<string, TimeSegment>
  /** Все сегменты, созданные или изменённые прогоном, — в порядке появления. */
  touched: TimeSegment[]
  /** Серверное время последнего онлайн-биения пары на любом устройстве (бюджет Р-21.3). */
  lastOnlineBeatAt: Date | null
  /** Зачтено за скользящие сутки по видам (`37` §7.11 «Потолок суток»). */
  daily: Record<LearningTimeKind, number>
  /** Зачтено при скрытой вкладке от медиа за всё время (потолок 1,5 × длины). */
  mediaUsed: number
  /** Потолок медиа в секундах; null — у элемента нет медиа известной длины, скрытая вкладка не засчитывается. */
  mediaCapSec: number | null
}

export function emptyPairState(): PairState {
  return { latest: new Map(), touched: [], lastOnlineBeatAt: null, daily: { content: 0, attempt: 0 }, mediaUsed: 0, mediaCapSec: null }
}

/** Биение после разбора: `at` — серверное время приёма (онлайн) или исправленное время клиента (догрузка). */
export interface BeatIn {
  sessionKey: string
  seq: number
  kind: LearningTimeKind
  enrollmentId: string | null
  activeMs: number
  visible: boolean
  /** Первое биение после «Ви ще тут?» → «Продовжити» (`37` §7.11, решение Р-21.12). */
  resume: boolean
  /** Последнее биение экрана: сегмент закрывается `session_end`. */
  end: boolean
  device: string | null
  at: Date
}

export interface BeatOut {
  /** Зачтено за это биение, секунд. */
  credited: number
  /** Выброшено за это биение, секунд (неактивная часть интервала, превышение потолков). */
  discarded: number
  segmentNo: number
  /** Сработал потолок: сегмента — показать «Ви ще тут?», суток — время больше не идёт. */
  capped: 'segment' | 'daily' | null
  /** Время стоит, пока человек не подтвердит присутствие: следующее биение — с `resume`. */
  stillHere: boolean
  /** Повтор уже принятого `(session_key, seq)` — ничего не начислено. */
  duplicate: boolean
  /** Осталось на сегодня по этой паре и виду, секунд. */
  dailyLeft: number
  /** Нарушение протокола: сеанс сменил вид — такой сеанс клиент обязан открыть заново. */
  invalid: 'kind_mismatch' | null
}

// ── Внутренние шаги ───────────────────────────────────────────────────────────────────────

function touch(pair: PairState, s: TimeSegment) {
  if (!s.dirty) {
    s.dirty = true
    pair.touched.push(s)
  }
}

/**
 * Закрыть сегмент. Короче 10 секунд — отбрасывается целиком: зачтённое уходит в выброшенное
 * и перестаёт считаться в суточный потолок и потолок медиа (`37` §7.11 «Минимальный сеанс»).
 */
export function closeSegment(pair: PairState, s: TimeSegment, reason: LearningTimeClosedReason) {
  if (s.closedReason !== null) return
  s.closedReason = reason
  if (s.creditedSeconds < R.minSegmentSec) {
    pair.daily[s.kind] = Math.max(0, pair.daily[s.kind] - s.creditedSeconds)
    pair.mediaUsed = Math.max(0, pair.mediaUsed - s.mediaSeconds)
    s.discardedSeconds += s.creditedSeconds
    s.creditedSeconds = 0
    s.mediaSeconds = 0
  }
  touch(pair, s)
}

function closeOthers(pair: PairState, keep: TimeSegment) {
  for (const s of pair.latest.values()) {
    if (s !== keep && s.closedReason === null) closeSegment(pair, s, 'navigated_away')
  }
}

function openSegment(pair: PairState, b: BeatIn, prev: TimeSegment | undefined, offline: boolean): TimeSegment {
  const s: TimeSegment = {
    id: null,
    sessionKey: b.sessionKey,
    segmentNo: (prev?.segmentNo ?? 0) + 1,
    kind: b.kind,
    // Сеанс — один заход на экран одной записи: запись берётся у сеанса, а не у биения
    // (она проверена на первом биении; следующие могли бы подставить чужую)
    enrollmentId: prev ? prev.enrollmentId : b.enrollmentId,
    startedAt: b.at,
    lastBeatAt: b.at,
    beatsCount: 0,
    creditedSeconds: 0,
    discardedSeconds: 0,
    mediaSeconds: 0,
    closedReason: null,
    isOfflineReplay: offline,
    lastSeq: prev?.lastSeq ?? 0,
    lastCredit: 0,
    device: b.device ?? prev?.device ?? null,
    dirty: false,
  }
  pair.latest.set(b.sessionKey, s)
  touch(pair, s)
  return s
}

function dailyLeftOf(pair: PairState, kind: LearningTimeKind) {
  return Math.max(0, R.dailyCapSec - pair.daily[kind])
}

/**
 * Сеанс вернулся после обрыва: `stale` было предварительным (Р-21.5) — сеанс не аварийный, он
 * простаивал или терял связь. Отметка отвергнутой старой догрузки (`stale` с пометкой
 * догрузки, `discardReplay`) не переписывается: это запись о потере, а не оборванный сеанс.
 */
function returned(pair: PairState, s: TimeSegment) {
  if (s.closedReason === 'stale' && !s.isOfflineReplay) {
    s.closedReason = 'idle_timeout'
    touch(pair, s)
  }
}

/** Принятое, но не зачтённое биение: номер запоминается, чтобы повтор узнавался (`37` §12). */
function acknowledge(pair: PairState, s: TimeSegment, b: BeatIn) {
  s.lastSeq = b.seq
  s.lastCredit = 0
  s.beatsCount += 1
  touch(pair, s)
}

/**
 * Зачёт одного биения в сегмент-цель. `ownSec` — интервал по часам сервера с прошлого биения
 * этого сегмента (Infinity у первого биения сегмента), `budgetSec` — с прошлого онлайн-биения
 * пары на любом устройстве (Infinity у догрузки и у первого биения пары).
 */
function credit(pair: PairState, s: TimeSegment, b: BeatIn, ownSec: number, budgetSec: number): { credited: number, discarded: number, capped: BeatOut['capped'] } {
  // Заявка клиента: не больше интервала биения. Клиентское время в зачёт не входит.
  const claimed = Math.min(Math.max(0, b.activeMs) / 1000, R.beatIntervalSec)
  let allowed = Math.max(0, Math.min(claimed, ownSec, budgetSec))
  // Скрытая вкладка: только воспроизведение медиа, суммарно не больше 1,5 × длины (`37` §7.11)
  if (!b.visible) {
    allowed = pair.mediaCapSec === null || b.kind !== 'content'
      ? 0
      : Math.min(allowed, Math.max(0, pair.mediaCapSec - pair.mediaUsed))
  }
  const byCaps = Math.min(allowed, dailyLeftOf(pair, b.kind), R.segmentCapSec - s.creditedSeconds)
  // Целые секунды вниз: сумма зачтённого не превышает суммы active_ms (проверка 22)
  const got = Math.max(0, Math.floor(byCaps))
  // Выброшенное (Р-21.7): неактивная часть интервала (у первого биения интервал неизвестен —
  // берётся заявка) плюс всё, что срезали потолки
  const interval = Number.isFinite(ownSec) ? Math.min(ownSec, R.idleTimeoutSec) : claimed
  const lost = Math.max(0, Math.floor(interval) - got)

  s.creditedSeconds += got
  s.discardedSeconds += lost
  if (!b.visible) {
    s.mediaSeconds += got
    pair.mediaUsed += got
  }
  pair.daily[b.kind] += got
  s.beatsCount += 1
  if (b.at > s.lastBeatAt) s.lastBeatAt = b.at
  s.lastSeq = b.seq
  s.lastCredit = got
  touch(pair, s)

  let capped: BeatOut['capped'] = null
  if (s.creditedSeconds >= R.segmentCapSec) {
    closeSegment(pair, s, 'segment_cap')
    capped = 'segment'
  }
  else if (dailyLeftOf(pair, b.kind) <= 0) {
    closeSegment(pair, s, 'daily_cap')
    capped = 'daily'
  }
  return { credited: got, discarded: lost, capped }
}

function out(pair: PairState, b: BeatIn, s: TimeSegment | undefined, part: Partial<BeatOut>): BeatOut {
  return {
    credited: 0,
    discarded: 0,
    segmentNo: s?.segmentNo ?? 0,
    capped: null,
    stillHere: false,
    duplicate: false,
    dailyLeft: dailyLeftOf(pair, b.kind),
    invalid: null,
    ...part,
  }
}

// ── Онлайн-биение ─────────────────────────────────────────────────────────────────────────

/**
 * Применить онлайн-биение к паре (`37` §7.10–7.12, §4). Правила по порядку:
 *
 * 1. **Повтор** `(session_key, seq)` — возвращает зачёт первого и ничего не начисляет.
 * 2. **Пауза больше 120 с** — вся пауза не засчитывается, сегмент закрывается `idle_timeout`,
 *    биение открывает следующий сегмент. Сегмент, закрытый фоновой задачей как `stale`, при
 *    возвращении того же сеанса переписывается на `idle_timeout` (Р-21.5).
 * 3. **После потолка сегмента** время стоит, пока не придёт биение с `resume` (Р-21.12);
 *    **после суточного** — пока не освободятся скользящие сутки.
 * 4. **Новый сегмент закрывает остальные открытые сегменты пары** с `navigated_away`: второе
 *    устройство, смена вида (контент → попытка) и новое открытие экрана (`37` §4, §7.12).
 * 5. **Скрытая вкладка без медиа** не засчитывается и сеанс не продлевает — пауза дольше
 *    120 с закроет его, как и без биений (`37` §7.11 «Фоновая вкладка»).
 */
export function applyOnlineBeat(pair: PairState, b: BeatIn): BeatOut {
  const prev = pair.latest.get(b.sessionKey)

  if (prev && b.seq <= prev.lastSeq) {
    return out(pair, b, prev, { duplicate: true, credited: b.seq === prev.lastSeq ? prev.lastCredit : 0 })
  }
  if (prev && prev.kind !== b.kind) return out(pair, b, prev, { invalid: 'kind_mismatch' })

  // Скрытая вкладка без медиа — ноль и никаких изменений; последнее биение экрана при этом
  // всё равно закрывает его сегмент (вкладку закрыли свёрнутой)
  const hiddenIdle = !b.visible && (pair.mediaCapSec === null || b.kind !== 'content')
  if (hiddenIdle) {
    if (b.end && prev) {
      // Вкладку закрыли свёрнутой: сегмент закрывается, а если свёрнута она была дольше
      // порога простоя — это простой, а не конец сеанса
      if (prev.closedReason === null) {
        const gapSec = (b.at.getTime() - prev.lastBeatAt.getTime()) / 1000
        closeSegment(pair, prev, gapSec > R.idleTimeoutSec ? 'idle_timeout' : 'session_end')
      }
      else returned(pair, prev)
    }
    return out(pair, b, prev, {})
  }

  let target: TimeSegment | null = null
  if (prev && prev.closedReason === null) {
    const gapSec = (b.at.getTime() - prev.lastBeatAt.getTime()) / 1000
    if (gapSec > R.idleTimeoutSec) closeSegment(pair, prev, 'idle_timeout')
    else target = prev
  }
  else if (prev) returned(pair, prev)

  if (!target) {
    // Последнее биение экрана без открытого сегмента — только сигнал закрытия: новый сегмент
    // ради него не открывается (иначе он закрыл бы открытый сеанс другого устройства)
    if (b.end) {
      if (prev) acknowledge(pair, prev, b)
      return out(pair, b, prev, {})
    }
    if (prev?.closedReason === 'segment_cap' && !b.resume) {
      acknowledge(pair, prev, b)
      return out(pair, b, prev, { capped: 'segment', stillHere: true })
    }
    if (prev?.closedReason === 'daily_cap' && dailyLeftOf(pair, b.kind) <= 0) {
      acknowledge(pair, prev, b)
      return out(pair, b, prev, { capped: 'daily' })
    }
    target = openSegment(pair, b, prev, false)
    closeOthers(pair, target)
  }

  const ownSec = target.beatsCount > 0 ? (b.at.getTime() - target.lastBeatAt.getTime()) / 1000 : Number.POSITIVE_INFINITY
  const budgetSec = pair.lastOnlineBeatAt ? (b.at.getTime() - pair.lastOnlineBeatAt.getTime()) / 1000 : Number.POSITIVE_INFINITY
  const r = credit(pair, target, b, ownSec, budgetSec)
  if (!pair.lastOnlineBeatAt || b.at > pair.lastOnlineBeatAt) pair.lastOnlineBeatAt = b.at
  if (b.end && target.closedReason === null) closeSegment(pair, target, 'session_end')

  return out(pair, b, target, { credited: r.credited, discarded: r.discarded, capped: r.capped, stillHere: r.capped === 'segment' })
}

// ── Офлайн-догрузка ───────────────────────────────────────────────────────────────────────

function groupBySession(beats: BeatIn[]): Map<string, BeatIn[]> {
  const bySession = new Map<string, BeatIn[]>()
  for (const b of beats) {
    const list = bySession.get(b.sessionKey)
    if (list) list.push(b)
    else bySession.set(b.sessionKey, [b])
  }
  return bySession
}

/**
 * Применить к паре биения одного сеанса, накопленные без связи (`37` §7.11 «Потеря связи»).
 * `beats` — уже с исправленным временем (`at`), отсортированы по `seq`.
 *
 * Серверных отметок у них нет, поэтому зачёт — по интервалам `client_ts`; бюджет пары к ним
 * не применяется (другое устройство в это время было онлайн и своё уже получило — пересечение
 * по времени клиента не проверяемо); сегменты закрываются сразу: разрыв больше 120 с —
 * `idle_timeout`, конец пакета — `session_end` (Р-21.13). Открытый онлайн-сегмент того же
 * сеанса закрывается `idle_timeout`: связь пропала — биения перестали приходить.
 */
export function applyReplay(pair: PairState, beats: BeatIn[]): { credited: number, discarded: number, duplicates: number, accepted: number, stillHere: boolean } {
  const bySession = groupBySession(beats)
  const sum = { credited: 0, discarded: 0, duplicates: 0, accepted: 0, stillHere: false }

  for (const list of bySession.values()) {
    list.sort((a, b) => a.seq - b.seq)
    let target: TimeSegment | null = null
    for (const b of list) {
      const prev = pair.latest.get(b.sessionKey)
      if (prev && b.seq <= prev.lastSeq) {
        sum.duplicates++
        continue
      }
      if (prev && prev.kind !== b.kind) continue
      sum.accepted++
      // Скрытая вкладка без медиа — ноль, как и онлайн
      if (!b.visible && (pair.mediaCapSec === null || b.kind !== 'content')) continue

      if (prev && prev !== target) {
        // Открытый онлайн-сегмент того же сеанса: связь пропала — биения перестали приходить
        if (prev.closedReason === null) closeSegment(pair, prev, 'idle_timeout')
        else returned(pair, prev)
      }
      if (target && target.closedReason === null) {
        const gapSec = (b.at.getTime() - target.lastBeatAt.getTime()) / 1000
        if (gapSec > R.idleTimeoutSec) {
          closeSegment(pair, target, 'idle_timeout')
          target = null
        }
      }
      else target = null

      if (!target) {
        const last = pair.latest.get(b.sessionKey)
        if (last?.closedReason === 'segment_cap' && !b.resume) {
          acknowledge(pair, last, b)
          sum.stillHere = true
          continue
        }
        if (last?.closedReason === 'daily_cap' && dailyLeftOf(pair, b.kind) <= 0) {
          acknowledge(pair, last, b)
          continue
        }
        target = openSegment(pair, b, last, true)
      }

      // Время клиента может идти не по порядку (перевели часы) — интервал не бывает отрицательным
      const ownSec = target.beatsCount > 0 ? Math.max(0, (b.at.getTime() - target.lastBeatAt.getTime()) / 1000) : Number.POSITIVE_INFINITY
      const r = credit(pair, target, b, ownSec, Number.POSITIVE_INFINITY)
      sum.credited += r.credited
      sum.discarded += r.discarded
      if (r.capped === 'segment') sum.stillHere = true
    }
    if (target && target.closedReason === null) closeSegment(pair, target, 'session_end')
  }
  return sum
}

/**
 * Догрузка старше 24 часов (`37` §7.11): не зачитывается, а её время пишется в выброшенное —
 * отдельным закрытым сегментом `stale` с пометкой догрузки. Номер последнего биения
 * запоминается, поэтому повторная отправка того же пакета потерю не удваивает.
 */
export function discardReplay(pair: PairState, beats: BeatIn[]): number {
  const bySession = groupBySession(beats)
  let lost = 0
  for (const [key, list] of bySession) {
    const prev = pair.latest.get(key)
    const fresh = list.filter(b => b.seq > (prev?.lastSeq ?? 0)).sort((a, b) => a.seq - b.seq)
    if (!fresh.length) continue
    const seconds = fresh.reduce((sum, b) => sum + Math.floor(Math.min(Math.max(0, b.activeMs) / 1000, R.beatIntervalSec)), 0)
    const first = fresh[0]!
    const s = openSegment(pair, first, prev, true)
    s.startedAt = new Date(Math.min(...fresh.map(b => b.at.getTime())))
    s.lastBeatAt = new Date(Math.max(...fresh.map(b => b.at.getTime())))
    s.beatsCount = fresh.length
    s.discardedSeconds = seconds
    s.lastSeq = fresh[fresh.length - 1]!.seq
    s.closedReason = 'stale'
    lost += seconds
  }
  return lost
}

// ── Достоверность ─────────────────────────────────────────────────────────────────────────

export interface ConfidenceInput {
  creditedSeconds: number
  firstStartedAt: Date | null
  lastActivityAt: Date | null
  hasOfflineReplay: boolean
  hasDailyCap: boolean
  /** Все сегменты закрыты фоновой задачей (`stale`) — сеансы обрывались, не заканчиваясь. */
  allStale: boolean
}

/**
 * Достоверность измерения (`37` §7.15). Покрытие — доля зачтённого от интервала «первое
 * открытие … последнее биение» плюс один интервал биения (первое биение зачитывает 30 секунд
 * до себя). `ok` — от 80 %; `partial` — 40–79 % либо была офлайн-догрузка; `unreliable` —
 * ниже 40 %, либо сработал суточный потолок, либо все сеансы оборвались (`stale`).
 */
export function timeConfidence(i: ConfidenceInput): ReviewTimeConfidence {
  if (i.hasDailyCap || i.allStale) return 'unreliable'
  if (!i.firstStartedAt || !i.lastActivityAt) return i.creditedSeconds > 0 ? 'partial' : 'unreliable'
  const spanSec = Math.max(1, (i.lastActivityAt.getTime() - i.firstStartedAt.getTime()) / 1000 + R.beatIntervalSec)
  const coverage = i.creditedSeconds / spanSec
  if (coverage < R.partialCoverage) return 'unreliable'
  if (i.hasOfflineReplay || coverage < R.okCoverage) return 'partial'
  return 'ok'
}

// ── Привязка сегментов к попытке и сдаче (Р-21.8) ─────────────────────────────────────────

/**
 * Сегмент выполнения теста относится к последней попытке, начатой не позже его начала: экран
 * попытки открывается после её создания, а следующая попытка начинается после отправки
 * предыдущей. Сегмент чтения описания теста (`content`) — к первой попытке, начатой после
 * него: человек читает условия перед стартом.
 */
export function attemptOfSegment(kind: LearningTimeKind, startedAt: Date, attempts: { id: string, startedAt: Date }[]): string | null {
  const sorted = [...attempts].sort((a, b) => a.startedAt.getTime() - b.startedAt.getTime())
  if (kind === 'attempt') {
    let found: string | null = null
    for (const a of sorted) if (a.startedAt.getTime() <= startedAt.getTime()) found = a.id
    return found
  }
  return sorted.find(a => a.startedAt.getTime() >= startedAt.getTime())?.id ?? null
}

/**
 * Сегмент практикума (и чтение задания, и работа над сдачей) относится к первой сдаче,
 * отправленной не раньше его начала, а если такой нет — к текущей неотправленной
 * (черновик, доработка). Доработка переиспользует строку сдачи, её `submitted_at` сдвигается
 * — время доработки остаётся в той же сдаче.
 */
export function submissionOfSegment(startedAt: Date, submissions: { id: string, attemptNo: number, submittedAt: Date | null }[]): string | null {
  const sorted = [...submissions].sort((a, b) => a.attemptNo - b.attemptNo)
  for (const s of sorted) {
    if (s.submittedAt === null || s.submittedAt.getTime() >= startedAt.getTime()) return s.id
  }
  return null
}

// ── Экран: счётчик активности между биениями ──────────────────────────────────────────────

/**
 * Сколько миллисекунд интервала человек был активен (`active_ms`, `37` §7.10) — считает экран.
 * Секунда засчитывается, если с последнего события (движение, клавиша, прокрутка, касание,
 * нажатие) прошло не больше 15 секунд и вкладка видна, либо если идёт воспроизведение медиа —
 * тогда и при скрытой вкладке (`37` §7.11 «Фоновая вкладка»).
 *
 * **Пауза** — время, которое не относится к измеряемому: форма жалобы поверх попытки
 * (`36` §7.7 — это время уже возвращено дедлайну сдвигом, и «Часом на випробування» оно не
 * является, решение Р-21.9), окно «Ви ще тут?». Пока счётчик на паузе, секунды не копятся,
 * и биения не уходят вовсе — пауза длиннее 120 секунд закроет сегмент, как простой.
 */
export class ActivityMeter {
  private lastActivityMs = Number.NEGATIVE_INFINITY
  private activeMs = 0
  private paused = false

  constructor(private readonly windowMs: number = R.activeWindowMs) {}

  /** Событие активности на экране. */
  activity(nowMs: number) {
    if (!this.paused) this.lastActivityMs = nowMs
  }

  /** Секундный шаг: засчитать `stepMs`, если человек был активен или шло медиа. */
  tick(nowMs: number, stepMs: number, state: { visible: boolean, mediaPlaying: boolean }) {
    if (this.paused) return
    if (state.mediaPlaying || (state.visible && nowMs - this.lastActivityMs <= this.windowMs)) this.activeMs += stepMs
  }

  pause() {
    this.paused = true
  }

  resume(nowMs: number) {
    this.paused = false
    this.lastActivityMs = nowMs
  }

  get isPaused() {
    return this.paused
  }

  /** Забрать накопленное за интервал биения и начать новый. */
  take(): number {
    const v = this.activeMs
    this.activeMs = 0
    return v
  }
}
