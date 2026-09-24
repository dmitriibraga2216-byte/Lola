import { describe, expect, it } from 'vitest'
import {
  ActivityMeter, LEARNING_TIME_RULES as R, applyOnlineBeat, applyReplay, attemptOfSegment, discardReplay,
  emptyPairState, submissionOfSegment, timeConfidence,
} from '../../shared/domain/learningTime'
import type { BeatIn, PairState, TimeSegment } from '../../shared/domain/learningTime'
import { beatSchema, beatsBatchSchema } from '../../shared/schemas/learningTime'

/**
 * PR-21 пакета `docs/v2`: правила учёта времени биениями без БД (`37` §7.10–7.15).
 * Критерии приёмки `37` §13 **7, 8, 9, 10** и сквозная проверка 22 (`42` §5) — здесь на
 * уровне правил; то же через сервис и базу — `tests/integration/v2-learning-time.spec.ts`,
 * нагрузка на 200 одновременных прохождений — `v2-learning-time-load.spec.ts`.
 */

const T0 = Date.parse('2026-09-24T09:00:00Z')
const at = (sec: number) => new Date(T0 + sec * 1000)

function beat(p: Partial<BeatIn> & { seq: number, t: number }): BeatIn {
  return {
    sessionKey: p.sessionKey ?? 'aaaaaaaa-0000-4000-8000-000000000001',
    seq: p.seq,
    kind: p.kind ?? 'content',
    enrollmentId: p.enrollmentId ?? null,
    activeMs: p.activeMs ?? 30_000,
    visible: p.visible ?? true,
    resume: p.resume ?? false,
    end: p.end ?? false,
    device: p.device ?? 'desktop',
    at: at(p.t),
  }
}

const segments = (pair: PairState, key?: string): TimeSegment[] =>
  pair.touched.filter(s => !key || s.sessionKey === key).sort((a, b) => a.segmentNo - b.segmentNo)
const credited = (pair: PairState) => pair.touched.reduce((s, x) => s + x.creditedSeconds, 0)

describe('критерий 7: урок открыт и 3 минуты без активности', () => {
  it('зачтено не больше 30 секунд, сегмент закрыт idle_timeout, следующая активность — сегмент 2', () => {
    const pair = emptyPairState()
    // Открыл урок, 30 секунд читал — первое биение
    applyOnlineBeat(pair, beat({ seq: 1, t: 30, activeMs: 30_000 }))
    // Три минуты без активности: экран биений не шлёт. Потом снова активен
    const r = applyOnlineBeat(pair, beat({ seq: 2, t: 30 + 180 + 30, activeMs: 12_000 }))
    const [s1, s2] = segments(pair)
    expect(s1!.closedReason).toBe('idle_timeout')
    expect(s1!.creditedSeconds).toBeLessThanOrEqual(30)
    // Вся пауза не засчитана: во втором сегменте — только активность после возвращения
    expect(r.segmentNo).toBe(2)
    expect(s2!.segmentNo).toBe(2)
    expect(s2!.creditedSeconds).toBe(12)
    expect(credited(pair)).toBeLessThanOrEqual(30 + 12)
  })

  it('короткое случайное открытие (< 10 с) выбрасывается целиком — в выброшенное', () => {
    const pair = emptyPairState()
    applyOnlineBeat(pair, beat({ seq: 1, t: 30, activeMs: 4_000 }))
    applyOnlineBeat(pair, beat({ seq: 2, t: 400, activeMs: 30_000 }))
    const [s1] = segments(pair)
    expect(s1!.closedReason).toBe('idle_timeout')
    expect(s1!.creditedSeconds).toBe(0)
    expect(s1!.discardedSeconds).toBe(4)
    expect(pair.daily.content).toBe(30)
  })
})

describe('критерий 8: свёрнутая вкладка', () => {
  it('статья: 10 минут скрытой вкладки не засчитаны, даже если клиент прислал биения', () => {
    const pair = emptyPairState()
    applyOnlineBeat(pair, beat({ seq: 1, t: 30 }))
    for (let i = 0; i < 20; i++) {
      const r = applyOnlineBeat(pair, beat({ seq: 2 + i, t: 60 + i * 30, visible: false }))
      expect(r.credited).toBe(0)
    }
    // Скрытые биения сеанс не продлили: вернувшееся видимое биение закрывает его по простою
    const r = applyOnlineBeat(pair, beat({ seq: 30, t: 30 + 600 + 30, activeMs: 10_000 }))
    expect(segments(pair)[0]!.closedReason).toBe('idle_timeout')
    expect(r.segmentNo).toBe(2)
    expect(credited(pair)).toBe(30 + 10)
  })

  it('видео: при скрытой вкладке засчитан прирост позиции воспроизведения', () => {
    const pair = emptyPairState()
    pair.mediaCapSec = Math.floor(900 * R.mediaFactor) // ролик 15 минут
    applyOnlineBeat(pair, beat({ seq: 1, t: 30 }))
    for (let i = 0; i < 20; i++) applyOnlineBeat(pair, beat({ seq: 2 + i, t: 60 + i * 30, visible: false, activeMs: 30_000 }))
    const [s] = segments(pair)
    expect(s!.closedReason).toBeNull()
    expect(s!.creditedSeconds).toBe(30 + 600)
    expect(s!.mediaSeconds).toBe(600)
  })

  it('перемотка и повторный просмотр упираются в 1,5 × длины медиа', () => {
    const pair = emptyPairState()
    pair.mediaCapSec = Math.floor(300 * R.mediaFactor) // ролик 5 минут → 450 с
    for (let i = 0; i < 40; i++) applyOnlineBeat(pair, beat({ seq: 1 + i, t: 30 + i * 30, visible: false }))
    expect(pair.mediaUsed).toBe(450)
    expect(credited(pair)).toBe(450)
  })

  it('без медиа известной длины скрытая вкладка не засчитывается никогда', () => {
    const pair = emptyPairState()
    for (let i = 0; i < 5; i++) applyOnlineBeat(pair, beat({ seq: 1 + i, t: 30 + i * 30, visible: false }))
    expect(credited(pair)).toBe(0)
    expect(pair.touched).toHaveLength(0)
  })
})

describe('критерий 9: 95 минут непрерывной активности', () => {
  it('зачтено 5400 секунд, «Ви ще тут?», после подтверждения — новый сегмент', () => {
    const pair = emptyPairState()
    let last = applyOnlineBeat(pair, beat({ seq: 1, t: 30 }))
    for (let n = 2; n <= 180; n++) last = applyOnlineBeat(pair, beat({ seq: n, t: n * 30 }))
    expect(last.capped).toBe('segment')
    expect(last.stillHere).toBe(true)
    const [s1] = segments(pair)
    expect(s1!.creditedSeconds).toBe(R.segmentCapSec)
    expect(s1!.closedReason).toBe('segment_cap')

    // Ещё пять минут активности без подтверждения: время стоит
    for (let n = 181; n <= 190; n++) {
      const r = applyOnlineBeat(pair, beat({ seq: n, t: n * 30 }))
      expect(r.credited).toBe(0)
      expect(r.stillHere).toBe(true)
    }
    expect(credited(pair)).toBe(5400)

    // «Продовжити» — первое биение с resume открывает сегмент 2
    const r = applyOnlineBeat(pair, beat({ seq: 191, t: 191 * 30, resume: true }))
    expect(r.segmentNo).toBe(2)
    expect(r.credited).toBe(30)
    expect(segments(pair)[1]!.closedReason).toBeNull()
  })
})

describe('критерий 10: телефон 40 минут без связи', () => {
  it('биения приняты, is_offline_replay, достоверность partial', () => {
    const pair = emptyPairState()
    const key = 'bbbbbbbb-0000-4000-8000-000000000002'
    for (let n = 1; n <= 3; n++) applyOnlineBeat(pair, beat({ sessionKey: key, seq: n, t: n * 30, device: 'mobile' }))
    // Связь пропала: 80 биений по 30 секунд копятся на телефоне и приходят пакетом
    const buffered = Array.from({ length: 80 }, (_, i) => beat({ sessionKey: key, seq: 4 + i, t: 120 + i * 30, device: 'mobile' }))
    const r = applyReplay(pair, buffered)
    expect(r.accepted).toBe(80)
    expect(r.credited).toBe(80 * 30)
    const segs = segments(pair, key)
    const online = segs.find(s => !s.isOfflineReplay)!
    expect(online.closedReason).toBe('idle_timeout')
    const offline = segs.filter(s => s.isOfflineReplay)
    expect(offline.length).toBeGreaterThan(0)
    expect(offline.every(s => s.closedReason !== null)).toBe(true)
    const total = segs.reduce((s, x) => s + x.creditedSeconds, 0)
    expect(timeConfidence({
      creditedSeconds: total,
      firstStartedAt: segs[0]!.startedAt,
      lastActivityAt: segs[segs.length - 1]!.lastBeatAt,
      hasOfflineReplay: true,
      hasDailyCap: false,
      allStale: false,
    })).toBe('partial')
  })

  it('повторная отправка того же пакета ничего не удваивает', () => {
    const pair = emptyPairState()
    const beats = Array.from({ length: 10 }, (_, i) => beat({ seq: 1 + i, t: 30 + i * 30 }))
    const first = applyReplay(pair, beats)
    const second = applyReplay(pair, beats)
    expect(first.credited).toBe(300)
    expect(second.credited).toBe(0)
    expect(second.duplicates).toBe(10)
  })

  it('старше 24 часов: не зачитывается, потеря — в выброшенном, повтор потерю не удваивает', () => {
    const pair = emptyPairState()
    const beats = Array.from({ length: 4 }, (_, i) => beat({ seq: 1 + i, t: i * 30, activeMs: 20_000 }))
    expect(discardReplay(pair, beats)).toBe(80)
    expect(discardReplay(pair, beats)).toBe(0)
    const [s] = segments(pair)
    expect(s!.creditedSeconds).toBe(0)
    expect(s!.discardedSeconds).toBe(80)
    expect(s!.closedReason).toBe('stale')
    expect(s!.isOfflineReplay).toBe(true)
  })
})

describe('сквозная проверка 22: время — биениями, а не «открыл — закрыл»', () => {
  it('вкладка открыта 3 часа, биений нет — засчитано ноль', () => {
    const pair = emptyPairState()
    // Экран открыт в 09:00, скрыт; единственное, что сервер узнает, — последнее биение экрана
    const r = applyOnlineBeat(pair, beat({ seq: 1, t: 3 * 3600, visible: false, activeMs: 0, end: true }))
    expect(r.credited).toBe(0)
    expect(credited(pair)).toBe(0)
  })

  it('засчитано не больше суммы active_ms — и не больше прошедшего по часам сервера', () => {
    const pair = emptyPairState()
    const actives = [30_000, 12_500, 7_000, 29_999, 45_000, 30_000, 1_000]
    let sumActive = 0
    actives.forEach((a, i) => {
      sumActive += a
      applyOnlineBeat(pair, beat({ seq: 1 + i, t: 30 + i * 30, activeMs: a }))
    })
    expect(credited(pair)).toBeLessThanOrEqual(Math.floor(sumActive / 1000))
    // Заявка «45 секунд за 30» срезана до 30: клиент не может дописать себе время
    expect(credited(pair)).toBe(30 + 12 + 7 + 29 + 30 + 30 + 1)
    // Биения чаще, чем идёт время, не засчитывают больше прошедшего
    const fast = emptyPairState()
    for (let i = 0; i < 10; i++) applyOnlineBeat(fast, beat({ seq: 1 + i, t: 30 + i }))
    expect(credited(fast)).toBe(30 + 9)
  })

  it('повтор биения с тем же seq не увеличивает счётчик и возвращает тот же credited', () => {
    const pair = emptyPairState()
    applyOnlineBeat(pair, beat({ seq: 1, t: 30 }))
    const first = applyOnlineBeat(pair, beat({ seq: 2, t: 60, activeMs: 17_000 }))
    const again = applyOnlineBeat(pair, beat({ seq: 2, t: 75, activeMs: 17_000 }))
    expect(first.credited).toBe(17)
    expect(again.duplicate).toBe(true)
    expect(again.credited).toBe(17)
    expect(credited(pair)).toBe(47)
    expect(segments(pair)[0]!.beatsCount).toBe(2)
  })
})

describe('пара «человек × элемент»: одно открытое, без удвоения, смена вида', () => {
  it('два устройства одновременно: сумма не больше реального времени (docs/03 §41)', () => {
    const pair = emptyPairState()
    const A = 'aaaaaaaa-0000-4000-8000-00000000000a'
    const B = 'bbbbbbbb-0000-4000-8000-00000000000b'
    for (let i = 0; i < 20; i++) {
      applyOnlineBeat(pair, beat({ sessionKey: A, seq: 1 + i, t: 30 + i * 30, device: 'desktop' }))
      applyOnlineBeat(pair, beat({ sessionKey: B, seq: 1 + i, t: 45 + i * 30, device: 'mobile' }))
    }
    // 10 минут на двух устройствах разом — не 20 минут
    expect(credited(pair)).toBeLessThanOrEqual(30 + 20 * 30)
    expect(pair.touched.filter(s => s.closedReason === null)).toHaveLength(1)
  })

  it('последовательно на двух устройствах — суммируется', () => {
    const pair = emptyPairState()
    for (let i = 0; i < 10; i++) applyOnlineBeat(pair, beat({ sessionKey: 'aaaaaaaa-0000-4000-8000-00000000000a', seq: 1 + i, t: 30 + i * 30 }))
    for (let i = 0; i < 10; i++) applyOnlineBeat(pair, beat({ sessionKey: 'bbbbbbbb-0000-4000-8000-00000000000b', seq: 1 + i, t: 1000 + i * 30 }))
    expect(credited(pair)).toBe(600)
  })

  it('открыли тест после чтения: сегмент контента закрыт navigated_away, открыт сегмент попытки', () => {
    const pair = emptyPairState()
    applyOnlineBeat(pair, beat({ sessionKey: 'cccccccc-0000-4000-8000-00000000000c', seq: 1, t: 30, kind: 'content' }))
    applyOnlineBeat(pair, beat({ sessionKey: 'dddddddd-0000-4000-8000-00000000000d', seq: 1, t: 60, kind: 'attempt' }))
    const content = pair.touched.find(s => s.kind === 'content')!
    const attempt = pair.touched.find(s => s.kind === 'attempt')!
    expect(content.closedReason).toBe('navigated_away')
    expect(attempt.closedReason).toBeNull()
    expect(pair.daily).toEqual({ content: 30, attempt: 30 })
  })

  it('сеанс не меняет вид на ходу — это нарушение протокола', () => {
    const pair = emptyPairState()
    applyOnlineBeat(pair, beat({ seq: 1, t: 30, kind: 'content' }))
    expect(applyOnlineBeat(pair, beat({ seq: 2, t: 60, kind: 'attempt' })).invalid).toBe('kind_mismatch')
  })

  it('stale предварителен: вернувшийся сеанс переписывает его на idle_timeout (Р-21.5)', () => {
    const pair = emptyPairState()
    applyOnlineBeat(pair, beat({ seq: 1, t: 30 }))
    applyOnlineBeat(pair, beat({ seq: 2, t: 60 }))
    const [s1] = segments(pair)
    s1!.closedReason = 'stale' // так её закрыла фоновая задача
    const r = applyOnlineBeat(pair, beat({ seq: 3, t: 900 }))
    expect(s1!.closedReason).toBe('idle_timeout')
    expect(r.segmentNo).toBe(2)
  })

  it('последнее биение экрана закрывает сегмент session_end', () => {
    const pair = emptyPairState()
    applyOnlineBeat(pair, beat({ seq: 1, t: 30 }))
    applyOnlineBeat(pair, beat({ seq: 2, t: 45, activeMs: 15_000, end: true }))
    expect(segments(pair)[0]!.closedReason).toBe('session_end')
    expect(credited(pair)).toBe(45)
  })
})

describe('потолок суток: 8 часов на связку «человек × элемент × вид»', () => {
  it('сверх потолка биения принимаются, но не зачитываются; сеанс закрыт daily_cap', () => {
    const pair = emptyPairState()
    let seq = 0
    let t = 0
    let last = applyOnlineBeat(pair, beat({ seq: ++seq, t: (t += 30) }))
    while (credited(pair) < R.dailyCapSec) {
      last = applyOnlineBeat(pair, beat({ seq: ++seq, t: (t += 30), resume: last.stillHere }))
    }
    expect(credited(pair)).toBe(R.dailyCapSec)
    expect(last.capped).toBe('daily')
    expect(last.dailyLeft).toBe(0)
    const more = applyOnlineBeat(pair, beat({ seq: ++seq, t: (t += 30) }))
    expect(more.credited).toBe(0)
    expect(more.capped).toBe('daily')
    expect(segments(pair).some(s => s.closedReason === 'daily_cap')).toBe(true)
  })
})

describe('достоверность (37 §7.15)', () => {
  const base = { firstStartedAt: at(0), lastActivityAt: at(570), hasOfflineReplay: false, hasDailyCap: false, allStale: false }
  it('ok от 80 % покрытия, partial 40–79 % или догрузка, unreliable ниже 40 %', () => {
    expect(timeConfidence({ ...base, creditedSeconds: 600 })).toBe('ok')
    expect(timeConfidence({ ...base, creditedSeconds: 480 })).toBe('ok')
    expect(timeConfidence({ ...base, creditedSeconds: 470 })).toBe('partial')
    expect(timeConfidence({ ...base, creditedSeconds: 600, hasOfflineReplay: true })).toBe('partial')
    expect(timeConfidence({ ...base, creditedSeconds: 239 })).toBe('unreliable')
  })
  it('суточный потолок и оборванные сеансы — unreliable при любом покрытии', () => {
    expect(timeConfidence({ ...base, creditedSeconds: 600, hasDailyCap: true })).toBe('unreliable')
    expect(timeConfidence({ ...base, creditedSeconds: 600, allStale: true })).toBe('unreliable')
  })
})

describe('привязка сегментов (Р-21.8)', () => {
  const attempts = [{ id: 'a1', startedAt: at(100) }, { id: 'a2', startedAt: at(1000) }]
  it('сегмент выполнения — к последней попытке, начатой не позже; чтение условий — к следующей', () => {
    expect(attemptOfSegment('attempt', at(150), attempts)).toBe('a1')
    expect(attemptOfSegment('attempt', at(1000), attempts)).toBe('a2')
    expect(attemptOfSegment('attempt', at(50), attempts)).toBeNull()
    expect(attemptOfSegment('content', at(50), attempts)).toBe('a1')
    expect(attemptOfSegment('content', at(500), attempts)).toBe('a2')
    expect(attemptOfSegment('content', at(2000), attempts)).toBeNull()
  })
  it('сегмент практикума — к первой сдаче, отправленной не раньше; иначе к черновику', () => {
    const subs = [{ id: 's1', attemptNo: 1, submittedAt: at(500) }, { id: 's2', attemptNo: 2, submittedAt: null }]
    expect(submissionOfSegment(at(100), subs)).toBe('s1')
    expect(submissionOfSegment(at(600), subs)).toBe('s2')
    expect(submissionOfSegment(at(600), [subs[0]!])).toBeNull()
  })
})

describe('экран: счётчик активности', () => {
  it('активен 15 секунд после события, скрытая вкладка — только медиа', () => {
    const m = new ActivityMeter()
    m.activity(0)
    for (let s = 1; s <= 30; s++) m.tick(s * 1000, 1000, { visible: true, mediaPlaying: false })
    expect(m.take()).toBe(15_000)
    for (let s = 31; s <= 60; s++) m.tick(s * 1000, 1000, { visible: false, mediaPlaying: s <= 40 })
    expect(m.take()).toBe(10_000)
  })

  it('форма жалобы поверх попытки: пока на паузе, секунды не копятся (Р-21.9)', () => {
    const m = new ActivityMeter()
    m.activity(0)
    for (let s = 1; s <= 10; s++) m.tick(s * 1000, 1000, { visible: true, mediaPlaying: false })
    m.pause()
    // 40 секунд человек пишет жалобу — печатает, кликает, — это не «Час на випробування»
    for (let s = 11; s <= 50; s++) {
      m.activity(s * 1000)
      m.tick(s * 1000, 1000, { visible: true, mediaPlaying: false })
    }
    expect(m.isPaused).toBe(true)
    m.resume(50_000)
    for (let s = 51; s <= 55; s++) m.tick(s * 1000, 1000, { visible: true, mediaPlaying: false })
    expect(m.take()).toBe(15_000)
  })
})

describe('контракт биения', () => {
  it('принимает поля 37 §10 и отвергает лишнее', () => {
    const ok = {
      sessionKey: 'aaaaaaaa-0000-4000-8000-000000000001', seq: 1, kind: 'content', subjectType: 'lesson',
      subjectId: 'aaaaaaaa-0000-4000-8000-000000000002', activeMs: 30_000, visible: true, clientTs: new Date().toISOString(),
    }
    expect(beatSchema.safeParse(ok).success).toBe(true)
    expect(beatSchema.safeParse({ ...ok, credited: 30 }).success).toBe(false)
    expect(beatSchema.safeParse({ ...ok, seq: 0 }).success).toBe(false)
    expect(beatSchema.safeParse({ ...ok, kind: 'reading' }).success).toBe(false)
    expect(beatsBatchSchema.safeParse({ beats: Array.from({ length: 201 }, () => ok) }).success).toBe(false)
    expect(beatsBatchSchema.safeParse({ beats: [ok], sentAt: new Date().toISOString() }).success).toBe(true)
  })
})
