<script setup lang="ts">
/**
 * Співбесіда — `/interview/session/:sessionId` (docs/v2/30-ai-interview.md §5.2, §7.6, §7.12).
 *
 * «Питання N з M», питання інтерв'юера текстом, таймер обдумування, «Записати відповідь» →
 * «Зупинити», лічильник тривалості з підсвіткою понад максимум, «Перезаписати (залишилось N)»,
 * «Відповісти текстом», «Далі». У шапці постійно — «Запис ведеться» і «Припинити співбесіду».
 *
 * Зв'язок (§7.12): биття раз на 5 секунд; при виході зі сторінки — `pause` запитом із
 * `keepalive`; повернення продовжує з тієї ж репліки, сервер відповідає `resumed` — екран пише
 * «Зв'язок відновлено, продовжуємо». Текст відповіді зберігається на пристрої кожні 5 секунд і
 * при кожній зміні, а запис голосу вантажиться в сховище одразу по зупинці — обрив не забирає
 * ні написаного, ні сказаного. Мовчання — три підказки на 15/30/45 с, далі
 * репліка закривається без відповіді й співбесіда йде далі.
 *
 * Оцінки ШІ кандидат не бачить ніколи: лише «Відповіді надіслано» і — якщо оцінку сформує
 * людина — один рядок без техніки (§5.2, §8).
 */
import type { ContentBlock } from '../../../../shared/schemas/content'
import { INTERVIEW_HEARTBEAT_SEC, INTERVIEW_SILENCE_PROMPTS_SEC } from '#shared/domain/interview'

definePageMeta({ layout: false })

const { t } = useI18n()
const { api } = useApi()
const route = useRoute()
const sessionId = route.params.sessionId as string

interface Session {
  id: string
  state: string
  answerMode: 'voice' | 'text' | null
  turnsTotal: number
  turnsAnswered: number
  secondsLeft: number | null
  scenario: { interviewerName: string, introText: string, outroText: string, answerModes: ('voice' | 'text')[], minAnswerSec: number, maxAnswerSec: number, thinkTimeSec: number, silenceTimeoutSec: number, retakeLimit: number }
  current: { ordinal: number, stem: ContentBlock[] | null, promptText: string | null, retakes: number, retakesLeft: number, hasRecording: boolean } | null
  needsHuman: boolean
  withdrawn: boolean
}

const session = ref<Session | null>(null)
const error = ref('')
const banner = ref('')
const offline = ref(false)
const busy = ref(false)
const confirmStop = ref(false)
const mode = ref<'voice' | 'text'>('voice')
const text = ref('')
const think = ref(0)
const recording = ref(false)
const elapsed = ref(0)
const silencePrompt = ref(0)
/** Запис уже в сховищі: кожна запис вантажиться одразу по зупинці, тож перезапис рахує сервер (§6.1). */
const recorded = ref<{ mediaId: string, durationMs: number, firstSoundDelayMs: number | null } | null>(null)
const uploading = ref(false)

const allowsText = computed(() => session.value?.scenario.answerModes.includes('text') ?? false)
const allowsVoice = computed(() => session.value?.scenario.answerModes.includes('voice') ?? false)
const live = computed(() => session.value && ['in_progress', 'paused', 'abandoned'].includes(session.value.state) && !session.value.withdrawn && session.value.current)
const finished = computed(() => session.value && !live.value && !session.value.withdrawn && session.value.state !== 'expired')
const overLimit = computed(() => !!session.value && elapsed.value > session.value.scenario.maxAnswerSec)
const draftKey = computed(() => session.value?.current ? `lola.interview.${sessionId}.${session.value.current.ordinal}` : '')

function questionText(s: Session): string {
  const blocks = s.current?.stem ?? []
  const fromStem = blocks.map((b) => {
    const r = b as { html?: unknown, text?: unknown }
    return typeof r.html === 'string' ? r.html.replace(/<[^>]*>/g, ' ') : typeof r.text === 'string' ? r.text : ''
  }).join(' ').replace(/\s+/g, ' ').trim()
  return fromStem || s.current?.promptText || ''
}

// ── Черновик ответа на устройстве (§7.12 «автозбереження кожні 5 с») ────────────────

function loadDraft() {
  try { text.value = (draftKey.value && localStorage.getItem(draftKey.value)) || '' }
  catch { text.value = '' }
}
function saveDraft() {
  try { if (draftKey.value) localStorage.setItem(draftKey.value, text.value) }
  catch { /* приватне вікно — чернетка живе лише в пам'яті */ }
}
function dropDraft(key: string) {
  try { localStorage.removeItem(key) }
  catch { /* без сховища видаляти нічого */ }
}

function applySession(s: Session) {
  const turnChanged = s.current?.ordinal !== session.value?.current?.ordinal
  session.value = s
  if (turnChanged) {
    mode.value = allowsVoice.value && s.answerMode !== 'text' ? 'voice' : 'text'
    if (!allowsText.value) mode.value = 'voice'
    if (!allowsVoice.value) mode.value = 'text'
    recorded.value = null
    elapsed.value = 0
    silencePrompt.value = 0
    loadDraft()
    startThink()
  }
}

async function load() {
  try {
    applySession(await api<Session>(`/interviews/${sessionId}`))
    await beat()
  }
  catch (err) { error.value = apiErrorOf(err).message }
}

// ── Таймер обдумывания ─────────────────────────────────────────────────────────────────

let thinkTimer: ReturnType<typeof setInterval> | undefined
function startThink() {
  clearInterval(thinkTimer)
  think.value = session.value?.scenario.thinkTimeSec ?? 0
  if (!think.value) return
  thinkTimer = setInterval(() => {
    think.value = Math.max(0, think.value - 1)
    if (!think.value) clearInterval(thinkTimer)
  }, 1000)
}

// ── Связь: биение, пауза, возврат ──────────────────────────────────────────────────────

let tabSwitches = 0
let beatTimer: ReturnType<typeof setInterval> | undefined
let draftTimer: ReturnType<typeof setInterval> | undefined

async function beat() {
  if (!live.value) return
  try {
    const r = await api<{ session: Session, resumed: boolean }>(`/interviews/${sessionId}/heartbeat`, { method: 'POST', body: { tabSwitches } })
    if (offline.value || r.resumed) banner.value = t('interview.session.resumed')
    offline.value = false
    applySession(r.session)
  }
  catch (err) {
    // Немає мережі — не помилка кандидата: відповідь збережена, продовжимо, щойно з'явиться зв'язок
    if (!apiErrorOf(err).code || apiErrorOf(err).code === 'internal') offline.value = true
    else error.value = apiErrorOf(err).message
  }
}

function csrf(): string {
  const m = document.cookie.match(/(?:^|;\s*)lola_csrf=([^;]*)/)
  return m ? decodeURIComponent(m[1]!) : ''
}

/** Уход со страницы — пауза (обрыв засчитывается сразу); `keepalive` доносит запрос и после закрытия вкладки. */
function onPageHide() {
  if (!live.value) return
  fetch(`/api/v1/interviews/${sessionId}/pause`, { method: 'POST', keepalive: true, headers: { 'x-csrf-token': csrf() } }).catch(() => {})
}
function onVisibility() {
  if (document.visibilityState === 'hidden') tabSwitches++
}

onMounted(() => {
  load()
  beatTimer = setInterval(beat, INTERVIEW_HEARTBEAT_SEC * 1000)
  draftTimer = setInterval(saveDraft, INTERVIEW_HEARTBEAT_SEC * 1000)
  window.addEventListener('pagehide', onPageHide)
  window.addEventListener('online', beat)
  document.addEventListener('visibilitychange', onVisibility)
})
onBeforeUnmount(() => {
  clearInterval(beatTimer)
  clearInterval(draftTimer)
  clearInterval(thinkTimer)
  window.removeEventListener('pagehide', onPageHide)
  window.removeEventListener('online', beat)
  document.removeEventListener('visibilitychange', onVisibility)
  stopMedia()
})

// ── Запись голоса (§5.2) ───────────────────────────────────────────────────────────────

let stream: MediaStream | null = null
let recorder: MediaRecorder | null = null
let audioCtx: AudioContext | null = null
let chunks: Blob[] = []
let startedAt = 0
let firstSoundAt: number | null = null
let lastSoundAt = 0
let tickTimer: ReturnType<typeof setInterval> | undefined
let raf = 0

function pickMime(): string {
  for (const m of ['audio/webm;codecs=opus', 'audio/webm', 'audio/ogg;codecs=opus', 'audio/ogg', 'audio/mp4']) {
    if (typeof MediaRecorder !== 'undefined' && MediaRecorder.isTypeSupported(m)) return m
  }
  return ''
}

/** Запись, остановленная не кандидатом (молчание, уход, отзыв), не загружается. */
let discardNext = false

function stopMedia() {
  clearInterval(tickTimer)
  cancelAnimationFrame(raf)
  if (recorder && recorder.state !== 'inactive') {
    discardNext = true
    recorder.stop()
  }
  stream?.getTracks().forEach(tr => tr.stop())
  stream = null
  audioCtx?.close().catch(() => {})
  audioCtx = null
}

async function record() {
  error.value = ''
  const mime = pickMime()
  try {
    stream = await navigator.mediaDevices.getUserMedia({ audio: true })
  }
  catch {
    error.value = allowsText.value ? t('interview.mic.denied') : t('interview.mic.deniedNoText')
    if (allowsText.value) mode.value = 'text'
    return
  }
  audioCtx = new AudioContext()
  const analyser = audioCtx.createAnalyser()
  audioCtx.createMediaStreamSource(stream).connect(analyser)
  const buf = new Uint8Array(analyser.fftSize)
  recorder = new MediaRecorder(stream, mime ? { mimeType: mime } : undefined)
  chunks = []
  recorder.ondataavailable = (e) => { if (e.data.size) chunks.push(e.data) }
  recorder.onstop = () => {
    const type = (recorder?.mimeType || mime || 'audio/webm').split(';')[0]!
    recording.value = false
    if (discardNext) { discardNext = false; return }
    uploadRecording(new Blob(chunks, { type }), type, Date.now() - startedAt, firstSoundAt ? firstSoundAt - startedAt : null)
  }
  startedAt = Date.now()
  firstSoundAt = null
  lastSoundAt = startedAt
  silencePrompt.value = 0
  elapsed.value = 0
  recorder.start(1000)
  recording.value = true
  // Уровень звука: первое слово и паузы — для подсказок «Не чути вас» (§7.12)
  const listen = () => {
    analyser.getByteTimeDomainData(buf)
    let sum = 0
    for (const v of buf) sum += ((v - 128) / 128) ** 2
    if (Math.sqrt(sum / buf.length) > 0.04) {
      lastSoundAt = Date.now()
      firstSoundAt ??= lastSoundAt
    }
    raf = requestAnimationFrame(listen)
  }
  listen()
  tickTimer = setInterval(() => {
    elapsed.value = Math.round((Date.now() - startedAt) / 1000)
    const quiet = (Date.now() - lastSoundAt) / 1000
    const prompts = INTERVIEW_SILENCE_PROMPTS_SEC
    if (firstSoundAt === null) {
      silencePrompt.value = prompts.filter(p => quiet >= p).length
      // Третья подсказка без звука — реплика закрывается молчанием, собеседование идёт дальше
      if (quiet >= prompts[prompts.length - 1]!) {
        stopMedia()
        recorded.value = null
        submit('none', Math.round(quiet * 1000))
      }
    }
  }, 500)
}

function stopRecording() {
  clearInterval(tickTimer)
  cancelAnimationFrame(raf)
  recorder?.stop()
  stream?.getTracks().forEach(tr => tr.stop())
  stream = null
  audioCtx?.close().catch(() => {})
  audioCtx = null
}

/**
 * Запис — у сховище одразу по зупинці (`41` §5.8: файл іде в S3 напряму, через API — лише
 * метадані). Повторний запис тієї ж репліки — перезапис: сервер рахує його й відповідає, скільки
 * лишилось; понад ліміт сценарію — `409 retake.limit`.
 */
async function uploadRecording(blob: Blob, mime: string, durationMs: number, firstSoundDelayMs: number | null) {
  const ordinal = session.value?.current?.ordinal
  if (!ordinal) return
  uploading.value = true
  error.value = ''
  try {
    const up = await api<{ mediaId: string, uploadUrl: string, retakesLeft: number }>(`/interviews/${sessionId}/turns/${ordinal}/upload`, { method: 'POST', body: { mime, bytes: blob.size } })
    const put = await fetch(up.uploadUrl, { method: 'PUT', body: blob, headers: { 'Content-Type': mime } })
    if (!put.ok) throw new Error('upload')
    recorded.value = { mediaId: up.mediaId, durationMs, firstSoundDelayMs }
    if (session.value?.current) session.value.current.retakesLeft = up.retakesLeft
  }
  catch (err) {
    const e = apiErrorOf(err)
    error.value = e.code === 'internal' ? t('interview.session.offline') : e.message
  }
  finally { uploading.value = false }
}

async function retake() {
  recorded.value = null
  await record()
}

// ── Отправка ответа ────────────────────────────────────────────────────────────────────

async function submit(kind: 'voice' | 'text' | 'none', silenceMs?: number) {
  const s = session.value
  if (!s?.current || busy.value) return
  busy.value = true
  error.value = ''
  const ordinal = s.current.ordinal
  const key = draftKey.value
  try {
    let next: Session
    if (kind === 'voice') {
      const rec = recorded.value
      if (!rec) { busy.value = false; return }
      next = await api<Session>(`/interviews/${sessionId}/turns/${ordinal}/answer`, { method: 'POST', body: { mode: 'voice', mediaId: rec.mediaId, durationMs: rec.durationMs, firstSoundDelayMs: rec.firstSoundDelayMs } })
    }
    else if (kind === 'text') {
      next = await api<Session>(`/interviews/${sessionId}/turns/${ordinal}/answer`, { method: 'POST', body: { mode: 'text', text: text.value } })
    }
    else {
      next = await api<Session>(`/interviews/${sessionId}/turns/${ordinal}/answer`, { method: 'POST', body: { mode: 'none', silenceMs: silenceMs ?? null } })
    }
    dropDraft(key)
    banner.value = ''
    applySession(next)
  }
  catch (err) {
    const e = apiErrorOf(err)
    error.value = e.code === 'internal' ? t('interview.session.offline') : e.message
  }
  finally { busy.value = false }
}

async function finish() {
  busy.value = true
  error.value = ''
  try { applySession(await api<Session>(`/interviews/${sessionId}/finish`, { method: 'POST' })) }
  catch (err) { error.value = apiErrorOf(err).message }
  finally { busy.value = false }
}

/** «Припинити співбесіду» — відкликання згоди (§7.6): записи видаляються, спроба не провалена. */
async function withdraw() {
  busy.value = true
  error.value = ''
  stopMedia()
  try {
    await api(`/interviews/${sessionId}/withdraw`, { method: 'POST', body: {} })
    confirmStop.value = false
    if (session.value) session.value = { ...session.value, withdrawn: true, current: null, state: 'abandoned' }
  }
  catch (err) { error.value = apiErrorOf(err).message }
  finally { busy.value = false }
}
</script>

<template>
  <main class="interview">
    <header class="bar">
      <span v-if="live && mode === 'voice'" class="rec" role="status"><span class="rec-dot" aria-hidden="true" />{{ t('interview.session.recording') }}</span>
      <span v-else class="muted">{{ session?.scenario.interviewerName ?? t('interview.title') }}</span>
      <button v-if="live" class="btn ghost small" type="button" @click="confirmStop = true">{{ t('interview.session.stop') }}</button>
    </header>

    <p v-if="error" class="note coral" role="alert">{{ error }}</p>
    <p v-if="offline" class="note sun" role="status">{{ t('interview.session.offline') }}</p>
    <p v-else-if="banner" class="note teal" role="status">{{ banner }}</p>

    <section v-if="confirmStop" class="card stack" role="alertdialog" aria-modal="true" :aria-label="t('interview.session.stop')">
      <p>{{ t('interview.session.stopConfirm') }}</p>
      <div class="actions">
        <button class="btn danger" type="button" :disabled="busy" @click="withdraw">{{ t('interview.session.stopYes') }}</button>
        <button class="btn ghost" type="button" :disabled="busy" @click="confirmStop = false">{{ t('interview.session.stopNo') }}</button>
      </div>
    </section>

    <section v-if="!session && !error" class="card" :aria-label="t('interview.loading')">
      <div v-for="i in 4" :key="i" class="skeleton" />
    </section>

    <template v-else-if="session">
      <!-- Хід співбесіди -->
      <section v-if="live && session.current" class="card stack">
        <p class="eyebrow">{{ t('interview.session.question', { n: session.current.ordinal, total: session.turnsTotal }) }}</p>
        <p class="q">{{ questionText(session) }}</p>
        <p v-if="think > 0 && !recording && !recorded" class="muted" aria-live="polite">{{ t('interview.session.think', { s: think }) }}</p>
        <p v-if="session.secondsLeft !== null" class="help">{{ t('interview.session.timeLeft', { m: Math.ceil(session.secondsLeft / 60) }) }}</p>

        <template v-if="mode === 'voice'">
          <p v-if="recording" :class="['duration', { over: overLimit }]" aria-live="polite">
            {{ t('interview.session.duration', { s: elapsed }) }}
            <span v-if="overLimit"> — {{ t('interview.session.overLimit', { max: session.scenario.maxAnswerSec }) }}</span>
          </p>
          <p v-if="recording && silencePrompt > 0" class="note sun" role="status">{{ t('interview.session.silence') }}</p>
          <p v-if="uploading" class="muted" role="status">{{ t('interview.session.sending') }}</p>
          <p v-else-if="recorded" class="muted">{{ t('interview.session.recorded', { s: Math.round(recorded.durationMs / 1000) }) }}</p>
          <div class="actions">
            <button v-if="!recording && !recorded" class="btn primary" type="button" :disabled="busy || uploading" @click="record">{{ t('interview.session.record') }}</button>
            <button v-if="recording" class="btn primary" type="button" @click="stopRecording">{{ t('interview.session.stopRecording') }}</button>
            <button v-if="recorded && !recording" class="btn primary" type="button" :disabled="busy || uploading" @click="submit('voice')">{{ t('interview.session.next') }}</button>
            <button v-if="recorded && !recording && session.current.retakesLeft > 0" class="btn ghost" type="button" :disabled="busy || uploading" @click="retake">
              {{ t('interview.session.retake', { n: session.current.retakesLeft }) }}
            </button>
            <button v-if="allowsText && !recording" class="btn ghost" type="button" :disabled="busy" @click="mode = 'text'">{{ t('interview.session.answerText') }}</button>
          </div>
        </template>

        <form v-else class="stack" @submit.prevent="submit('text')">
          <label class="stack">
            <span class="label">{{ t('interview.session.textLabel') }}</span>
            <textarea v-model="text" class="field" rows="6" maxlength="5000" @input="saveDraft" />
          </label>
          <div class="actions">
            <button class="btn primary" type="submit" :disabled="busy || !text.trim()">{{ t('interview.session.next') }}</button>
            <button v-if="allowsVoice" class="btn ghost" type="button" :disabled="busy" @click="mode = 'voice'">{{ t('interview.session.answerVoice') }}</button>
          </div>
        </form>

        <div v-if="session.turnsAnswered > 0" class="finish">
          <button class="btn ghost small" type="button" :disabled="busy || recording" @click="finish">{{ t('interview.session.finish') }}</button>
        </div>
      </section>

      <section v-else-if="session.withdrawn" class="card" role="status">
        <p>{{ t('interview.session.withdrawn') }}</p>
      </section>

      <section v-else-if="session.state === 'expired'" class="card" role="status">
        <p>{{ t('interview.session.expired') }}</p>
      </section>

      <!-- Фінал (§5.2): без обіцянки конкретної години; деградація — одним рядком без техніки -->
      <section v-else-if="finished" class="card stack" role="status">
        <h1 class="h1">{{ t('interview.session.doneTitle') }}</h1>
        <p>{{ session.scenario.outroText }}</p>
        <p>{{ t('interview.session.doneText') }}</p>
        <p v-if="session.needsHuman" class="muted">{{ t('interview.session.degraded') }}</p>
      </section>
    </template>
  </main>
</template>

<style scoped>
.interview { max-width: 40rem; margin: 0 auto; padding: var(--space-4) var(--space-4) var(--space-7); display: grid; gap: var(--space-4); }
.bar { display: flex; justify-content: space-between; align-items: center; gap: var(--space-2); flex-wrap: wrap; }
.rec { display: inline-flex; align-items: center; gap: var(--space-2); font-weight: 800; color: var(--color-coral-ink); }
.rec-dot { width: var(--space-3); height: var(--space-3); border-radius: var(--radius-pill); background: var(--color-coral); }
.stack { display: grid; gap: var(--space-3); }
.eyebrow { margin: 0; color: var(--color-ink-muted); font-weight: 800; font-size: var(--font-size-body-s); }
.q { margin: 0; font-size: var(--font-size-title-l); font-weight: 800; }
.h1 { margin: 0; font-size: var(--font-size-title-l); font-weight: 900; }
.duration { margin: 0; font-weight: 800; font-variant-numeric: tabular-nums; }
.duration.over { color: var(--color-coral-ink); }
.actions { display: flex; flex-wrap: wrap; gap: var(--space-2); }
.finish { border-top: 1px solid var(--color-bg-line-soft); padding-top: var(--space-3); }
.skeleton { height: var(--space-4); margin: var(--space-2) 0; border-radius: var(--radius-s); background: var(--color-bg-line-soft); }
@media (max-width: 480px) {
  .actions { flex-direction: column; }
  .actions .btn { width: 100%; justify-content: center; white-space: normal; }
}
</style>
