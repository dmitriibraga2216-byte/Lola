import { ActivityMeter, LEARNING_TIME_RULES } from '#shared/domain/learningTime'
import type { LearningTimeKind, LearningTimeSubjectType } from '#shared/enums'
import type { BeatInput, BeatResult, BeatsBatchResult } from '#shared/schemas/learningTime'

/**
 * Счётчик времени экрана прохождения — биения (docs/v2/37 §7.10–7.12, PR-21).
 *
 * Экран сообщает факты, сервер решает (CLAUDE.md п. 3): каждые 30 секунд уходит биение
 * «сколько миллисекунд из них человек был активен, видна ли вкладка»; сколько зачесть, считает
 * сервер по своим часам. Биение **не уходит**, если активности не было или вкладка скрыта без
 * воспроизведения медиа (`37` §7.10). Разница «открыл — закрыл» не считается нигде.
 *
 * - **Сеанс** — один заход на экран и один вид времени: `sessionKey` новый на каждый заход и
 *   на каждую смену вида (чтение условий → выполнение, `setKind`).
 * - **«Ви ще тут?»** — после 90 минут подряд сервер отвечает `stillHere`: время стоит, пока
 *   человек не нажмёт «Продовжити» (`confirmStillHere`), следующее биение уходит с `resume`.
 * - **Пауза** — время, которое к измеряемому не относится: форма жалобы поверх попытки
 *   (Р-21.9 — это время уже возвращено дедлайну, и «Часом на випробування» оно не является).
 * - **Без связи** биения копятся в `localStorage` (до 200 = 100 минут) и уходят пакетом, как
 *   только связь вернулась; пока буфер не пуст, новые биения встают в его конец — порядок `seq`
 *   не нарушается. Буфер привязан к пользователю: на общем планшете точки биения одного не
 *   досылаются под входом другого (Р-21.16).
 * - **Уход с экрана** — последнее биение с `end`, отправленное `keepalive`: оно переживает
 *   навигацию и закрытие вкладки, сегмент закрывается `session_end`, а не `stale`.
 */
export interface LearningTimeOptions {
  subjectType: LearningTimeSubjectType
  subjectId: string
  enrollmentId?: string | null
  /** Идёт ли воспроизведение медиа на экране — тогда секунды идут и при скрытой вкладке. */
  mediaPlaying?: () => boolean
}

const R = LEARNING_TIME_RULES
const ACTIVITY_EVENTS = ['mousemove', 'keydown', 'scroll', 'touchstart', 'pointerdown', 'wheel'] as const

/** Любое видео или аудио на странице играет — `timeupdate` идёт, человек смотрит. */
function anyMediaPlaying(): boolean {
  return Array.from(document.querySelectorAll('video, audio')).some(m => !(m as HTMLMediaElement).paused && !(m as HTMLMediaElement).ended)
}

function newKey(): string {
  return crypto.randomUUID()
}

/** Сетевой сбой, а не отказ сервера: у ответа нет статуса или это 5xx — биение надо сохранить. */
function isTransient(err: unknown): boolean {
  const status = (err as { statusCode?: number, status?: number })?.statusCode ?? (err as { status?: number })?.status
  return !status || status >= 500
}

export function useLearningTime(opts: LearningTimeOptions) {
  const { api, csrf } = useApi()
  const { me } = useAuth()
  const stillHere = ref(false)
  const dailyCapped = ref(false)

  const meter = new ActivityMeter()
  let kind: LearningTimeKind | null = null
  let sessionKey = newKey()
  let seq = 0
  let resumeNext = false
  /** Последнее биение сеанса уже ушло: второе (`pagehide`, затем размонтирование) не нужно. */
  let finished = false
  let flushing = false
  let secondTimer: ReturnType<typeof setInterval> | undefined
  let beatTimer: ReturnType<typeof setInterval> | undefined
  const device = import.meta.client && window.innerWidth < 768 ? 'mobile' : 'desktop'
  const mediaPlaying = opts.mediaPlaying ?? anyMediaPlaying

  // ── Офлайн-буфер (`37` §7.11 «Потеря связи») ──────────────────────────────────────────
  const bufferKey = () => (me.value?.user.id ? `lola.time.buffer.${me.value.user.id}` : null)
  function readBuffer(): BeatInput[] {
    const k = bufferKey()
    if (!k) return []
    try { return JSON.parse(localStorage.getItem(k) || '[]') as BeatInput[] }
    catch { return [] }
  }
  function writeBuffer(beats: BeatInput[]) {
    const k = bufferKey()
    if (!k) return
    try {
      if (beats.length) localStorage.setItem(k, JSON.stringify(beats.slice(-R.offlineBufferMax)))
      else localStorage.removeItem(k)
    }
    catch { /* хранилище недоступно (приватный режим) — биения теряются, как без буфера */ }
  }

  async function flush() {
    if (flushing) return
    const beats = readBuffer()
    if (!beats.length) return
    flushing = true
    try {
      const r = await api<BeatsBatchResult>('/learning/time/beats', { method: 'POST', body: { beats, sentAt: new Date().toISOString() } })
      // Отправленное — из буфера; то, что встало в конец за время запроса, остаётся
      writeBuffer(readBuffer().slice(beats.length))
      if (r.stillHere) showStillHere()
    }
    catch (err) {
      // Отказ сервера (пакет старше суток, чужой элемент) не исправится повтором — буфер
      // очищается; сетевой сбой — пакет ждёт следующей попытки
      if (!isTransient(err)) writeBuffer(readBuffer().slice(beats.length))
    }
    finally { flushing = false }
  }

  function buffer(b: BeatInput) {
    writeBuffer([...readBuffer(), b])
  }

  // ── Биения ─────────────────────────────────────────────────────────────────────────────
  function build(end: boolean, visible = !document.hidden): BeatInput | null {
    if (!kind || (end && finished)) return null
    const activeMs = meter.take()
    if (!end && activeMs <= 0) return null
    finished = end
    if (!end && !visible && !mediaPlaying()) return null
    const b: BeatInput = {
      sessionKey,
      seq: ++seq,
      kind,
      subjectType: opts.subjectType,
      subjectId: opts.subjectId,
      enrollmentId: opts.enrollmentId ?? null,
      activeMs,
      visible,
      clientTs: new Date().toISOString(),
      device,
      ...(resumeNext ? { resume: true } : {}),
      ...(end ? { end: true } : {}),
    }
    resumeNext = false
    return b
  }

  function showStillHere() {
    stillHere.value = true
    meter.pause()
  }

  async function send(b: BeatInput) {
    if (readBuffer().length || !navigator.onLine) {
      buffer(b)
      void flush()
      return
    }
    try {
      const r = await api<BeatResult>('/learning/time/beat', { method: 'POST', body: b })
      if (r.stillHere) showStillHere()
      if (r.capped === 'daily') dailyCapped.value = true
    }
    catch (err) {
      if (isTransient(err)) buffer(b)
    }
  }

  function beat(visible?: boolean) {
    if (stillHere.value || dailyCapped.value) {
      meter.take()
      return
    }
    const b = build(false, visible)
    if (b) void send(b)
  }

  /** Последнее биение сеанса: `keepalive` переживает уход со страницы. */
  function finish() {
    const b = build(true)
    if (!b) return
    if (readBuffer().length || !navigator.onLine) {
      buffer(b)
      return
    }
    try {
      void fetch('/api/v1/learning/time/beat', {
        method: 'POST',
        keepalive: true,
        credentials: 'same-origin',
        headers: { 'content-type': 'application/json', ...(csrf.value ? { 'x-csrf-token': csrf.value } : {}) },
        body: JSON.stringify(b),
      }).catch(() => buffer(b))
    }
    catch { buffer(b) }
  }

  // ── Управление ─────────────────────────────────────────────────────────────────────────
  /** Сменить вид времени (или остановить счёт — `null`): новый сеанс, старый закрывается. */
  function setKind(next: LearningTimeKind | null) {
    if (next === kind) return
    if (kind) finish()
    kind = next
    sessionKey = newKey()
    seq = 0
    finished = false
    meter.take()
    if (next) meter.activity(Date.now())
  }

  function pause() {
    meter.pause()
  }

  function resume() {
    if (!stillHere.value) meter.resume(Date.now())
  }

  /** «Продовжити» в «Ви ще тут?»: время снова идёт, следующее биение открывает новый сегмент. */
  function confirmStillHere() {
    stillHere.value = false
    resumeNext = true
    meter.resume(Date.now())
  }

  // Форма жалобы открыта — время стоит (Р-21.9); закрыли — идёт дальше
  const issueFormsOpen = useState<number>('issue:formOpen', () => 0)
  watch(issueFormsOpen, n => (n > 0 ? pause() : resume()))

  const onActivity = () => meter.activity(Date.now())
  const onVisibility = () => {
    // Вкладку свернули — накопленное за видимые секунды уходит сразу, пока страница жива
    if (document.hidden) beat(true)
  }
  const onOnline = () => { void flush() }
  const onPageHide = () => finish()

  onMounted(() => {
    for (const e of ACTIVITY_EVENTS) window.addEventListener(e, onActivity, { passive: true })
    document.addEventListener('visibilitychange', onVisibility)
    window.addEventListener('online', onOnline)
    window.addEventListener('pagehide', onPageHide)
    secondTimer = setInterval(() => meter.tick(Date.now(), 1000, { visible: !document.hidden, mediaPlaying: mediaPlaying() }), 1000)
    beatTimer = setInterval(() => beat(), R.beatIntervalSec * 1000)
    void flush()
  })

  onUnmounted(() => {
    finish()
    kind = null
    clearInterval(secondTimer)
    clearInterval(beatTimer)
    for (const e of ACTIVITY_EVENTS) window.removeEventListener(e, onActivity)
    document.removeEventListener('visibilitychange', onVisibility)
    window.removeEventListener('online', onOnline)
    window.removeEventListener('pagehide', onPageHide)
  })

  return { stillHere, dailyCapped, setKind, pause, resume, confirmStillHere }
}
