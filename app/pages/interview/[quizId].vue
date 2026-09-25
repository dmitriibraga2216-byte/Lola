<script setup lang="ts">
/**
 * Вхід у співбесіду — `/interview/:quizId` (docs/v2/30-ai-interview.md §5.1, §6.3, §7.4, §7.5,
 * §7.12, §12 п. 1). Екран згоди до будь-якої спроби: шість рядків тексту згоди приходять із
 * сервера — саме ту редакцію, чий хеш сервер і запише (текст згоди — юридичний документ, а не
 * рядок інтерфейсу). «Не погоджуюсь» — рівноцінна кнопка звичайного кеглю: відмова не закриває
 * відбір, кандидат обирає альтернативу сценарію. Далі — перевірка мікрофона і старт сесії.
 *
 * Усе вирішує сервер (CLAUDE.md п. 3): що показати (`next`), чи доступний ШІ, чи можна письмову
 * форму. Екран лише показує й передає вибір.
 */
import type { ContentBlock } from '../../../shared/schemas/content'

definePageMeta({ layout: false })

const { t } = useI18n()
const { api } = useApi()
const route = useRoute()
const quizId = route.params.quizId as string
const enrollmentId = (route.query.enrollmentId as string) || undefined
const lessonId = (route.query.lessonId as string) || undefined

type Next = 'consent' | 'start' | 'resume' | 'alternative' | 'text_form' | 'unavailable' | 'withdrawn' | 'done'
interface Entry {
  quizTitle: string
  scenario: { interviewerName: string, introText: string, outroText: string, answerModes: ('voice' | 'text')[], alternativePath: 'human_interview' | 'text_form' }
  consent: { title: string, lines: string[], full: string[], textVersion: string, textHash: string }
  next: Next
  ai: { available: boolean, reason?: string }
  sessionId: string | null
  lastSession: { needsHuman: boolean } | null
  textForm: { attemptId: string, status: string } | null
}
interface TextForm { attemptId: string, status: string, quizTitle: string, questions: { id: string, ordinal: number, stem: ContentBlock[], answer: string }[] }

const entry = ref<Entry | null>(null)
const phase = ref<'loading' | 'error' | 'consent' | 'decline' | 'mic' | 'waiting' | 'unavailable' | 'text_form' | 'withdrawn' | 'done'>('loading')
const loadError = ref('')
const error = ref('')
const busy = ref(false)
const showFull = ref(false)
const preferredTime = ref('')
const unavailableReason = ref<'ai_unavailable' | 'no_microphone'>('ai_unavailable')
const form = ref<TextForm | null>(null)
const saved = ref<Record<string, boolean>>({})

const query = computed(() => ({ ...(enrollmentId ? { enrollmentId } : {}), ...(lessonId ? { lessonId } : {}) }))
const allowsText = computed(() => entry.value?.scenario.answerModes.includes('text') ?? false)
const allowsVoice = computed(() => entry.value?.scenario.answerModes.includes('voice') ?? false)
const alternative = computed(() => entry.value?.scenario.alternativePath ?? 'human_interview')

async function load() {
  phase.value = 'loading'
  loadError.value = ''
  try {
    const e = await api<Entry>(`/interviews/entry/${quizId}`, { query: query.value })
    entry.value = e
    await route_(e.next)
  }
  catch (err) {
    loadError.value = apiErrorOf(err).message
    phase.value = 'error'
  }
}

async function route_(next: Next) {
  error.value = ''
  switch (next) {
    case 'resume': return navigateTo(`/interview/session/${entry.value!.sessionId}`, { replace: true })
    case 'start': phase.value = 'mic'; return
    case 'alternative': phase.value = 'waiting'; return
    case 'text_form': return openTextForm()
    case 'unavailable': phase.value = 'unavailable'; return
    case 'withdrawn': phase.value = 'withdrawn'; return
    case 'done': phase.value = 'done'; return
    default: phase.value = 'consent'
  }
}
onMounted(load)

async function decide(decision: 'accepted' | 'declined') {
  if (!entry.value) return
  busy.value = true
  error.value = ''
  try {
    const r = await api<{ next: Next }>(`/interviews/entry/${quizId}/consent`, {
      method: 'POST',
      body: {
        decision, textVersion: entry.value.consent.textVersion, textHash: entry.value.consent.textHash,
        ...(decision === 'declined' ? { alternative: alternative.value, ...(preferredTime.value.trim() ? { preferredTime: preferredTime.value.trim() } : {}) } : {}),
        ...query.value,
      },
    })
    await route_(r.next)
  }
  catch (err) {
    error.value = apiErrorOf(err).message
    // Текст згоди оновився — показуємо нову редакцію, а не зберігаємо згоду зі старою
    if (apiErrorOf(err).code === 'interview_consent.invalid') await load()
  }
  finally { busy.value = false }
}

/** Альтернатива без відмови: ШІ недоступний або немає мікрофона (§7.12, §12 п. 1). */
async function takeAlternative() {
  busy.value = true
  error.value = ''
  try {
    const r = await api<{ next: Next }>(`/interviews/entry/${quizId}/alternative`, {
      method: 'POST',
      body: { reason: unavailableReason.value, ...(preferredTime.value.trim() ? { preferredTime: preferredTime.value.trim() } : {}), ...query.value },
    })
    await route_(r.next)
  }
  catch (err) { error.value = apiErrorOf(err).message }
  finally { busy.value = false }
}

// ── Перевірка мікрофона і старт (§5.2 «Крок 0») ──────────────────────────────────────

const level = ref(0)
const micState = ref<'idle' | 'checking' | 'ok' | 'denied'>('idle')
let stream: MediaStream | null = null
let audioCtx: AudioContext | null = null
let raf = 0

async function checkMic() {
  micState.value = 'checking'
  try {
    stream = await navigator.mediaDevices.getUserMedia({ audio: true })
    audioCtx = new AudioContext()
    const analyser = audioCtx.createAnalyser()
    audioCtx.createMediaStreamSource(stream).connect(analyser)
    const buf = new Uint8Array(analyser.fftSize)
    const tick = () => {
      analyser.getByteTimeDomainData(buf)
      let sum = 0
      for (const v of buf) sum += ((v - 128) / 128) ** 2
      level.value = Math.min(1, Math.sqrt(sum / buf.length) * 4)
      raf = requestAnimationFrame(tick)
    }
    tick()
    micState.value = 'ok'
  }
  catch {
    micState.value = 'denied'
  }
}

function releaseMic() {
  cancelAnimationFrame(raf)
  stream?.getTracks().forEach(tr => tr.stop())
  stream = null
  audioCtx?.close().catch(() => {})
  audioCtx = null
}
onBeforeUnmount(releaseMic)

async function start(answerMode: 'voice' | 'text') {
  busy.value = true
  error.value = ''
  releaseMic()
  try {
    const r = await api<{ sessionId: string }>(`/interviews/entry/${quizId}/start`, { method: 'POST', body: { answerMode, ...query.value } })
    await navigateTo(`/interview/session/${r.sessionId}`)
  }
  catch (err) {
    const e = apiErrorOf(err)
    // Ліміт вичерпано або ШІ недоступний — сесія не стартує, пропонуємо альтернативу (§13 к. 7)
    if (e.code === 'limit_exceeded' || e.code === 'ai.unavailable') {
      unavailableReason.value = 'ai_unavailable'
      phase.value = 'unavailable'
    }
    else error.value = e.message
  }
  finally { busy.value = false }
}

function noMicrophone() {
  releaseMic()
  unavailableReason.value = 'no_microphone'
  phase.value = 'unavailable'
}

// ── Письмова форма (§6.3, §7.5) ──────────────────────────────────────────────────────

async function openTextForm() {
  busy.value = true
  error.value = ''
  try {
    const attemptId = entry.value?.textForm?.attemptId
      ?? (await api<{ attemptId: string }>(`/interviews/entry/${quizId}/text-form`, { method: 'POST', body: query.value })).attemptId
    form.value = await api<TextForm>(`/interviews/text-form/${attemptId}`)
    phase.value = 'text_form'
  }
  catch (err) {
    error.value = apiErrorOf(err).message
    phase.value = 'waiting'
  }
  finally { busy.value = false }
}

async function saveAnswer(qid: string, text: string) {
  if (!form.value) return
  try {
    await api(`/interviews/text-form/${form.value.attemptId}/answers/${qid}`, { method: 'PUT', body: { text } })
    saved.value = { ...saved.value, [qid]: true }
  }
  catch (err) { error.value = apiErrorOf(err).message }
}

async function submitForm() {
  if (!form.value) return
  busy.value = true
  error.value = ''
  try {
    for (const q of form.value.questions) await saveAnswer(q.id, q.answer)
    const r = await api<{ status: string }>(`/interviews/text-form/${form.value.attemptId}/submit`, { method: 'POST' })
    form.value = { ...form.value, status: r.status }
  }
  catch (err) { error.value = apiErrorOf(err).message }
  finally { busy.value = false }
}

/** Текст питання зі знімка — без розмітки (питання співбесіди — текстові блоки). */
function stemText(stem: ContentBlock[] | null | undefined): string {
  return (stem ?? []).map((b) => {
    const r = b as { html?: unknown, text?: unknown }
    return typeof r.html === 'string' ? r.html.replace(/<[^>]*>/g, ' ') : typeof r.text === 'string' ? r.text : ''
  }).join(' ').replace(/\s+/g, ' ').trim()
}
</script>

<template>
  <main class="interview" :aria-busy="phase === 'loading'">
    <header class="head">
      <p class="eyebrow">{{ entry?.quizTitle ?? t('interview.title') }}</p>
      <h1>{{ entry?.consent.title ?? t('interview.title') }}</h1>
    </header>

    <!-- Завантаження: скелет із шести рядків (§5.1) -->
    <section v-if="phase === 'loading'" class="card" :aria-label="t('interview.loading')">
      <div v-for="i in 6" :key="i" class="skeleton" />
    </section>

    <section v-else-if="phase === 'error'" class="card" role="alert">
      <p class="error-text">{{ t('interview.loadError') }}</p>
      <p class="muted">{{ loadError }}</p>
      <button class="btn primary" type="button" @click="load">{{ t('interview.retry') }}</button>
    </section>

    <template v-else-if="entry">
      <p v-if="error" class="note coral" role="alert">{{ error }}</p>

      <!-- §5.1 Згода кандидата -->
      <section v-if="phase === 'consent'" class="card stack">
        <p class="muted">{{ t('interview.consent.interviewer', { name: entry.scenario.interviewerName }) }}</p>
        <ul class="lines">
          <li v-for="(line, i) in entry.consent.lines" :key="i">
            <span class="dot" aria-hidden="true" />
            <span>{{ line }}</span>
          </li>
        </ul>
        <button class="link-btn" type="button" :aria-expanded="showFull" @click="showFull = !showFull">
          {{ showFull ? t('interview.consent.hideFullText') : t('interview.consent.fullText') }}
        </button>
        <div v-if="showFull" class="full">
          <p v-for="(p, i) in entry.consent.full" :key="i">{{ p }}</p>
        </div>
        <div class="actions">
          <button class="btn primary big" type="button" :disabled="busy" @click="decide('accepted')">{{ t('interview.consent.agree') }}</button>
          <button class="btn ghost big" type="button" :disabled="busy" @click="phase = 'decline'">{{ t('interview.consent.decline') }}</button>
        </div>
      </section>

      <!-- §6.3 Відмова від ШІ-співбесіди -->
      <form v-else-if="phase === 'decline'" class="card stack" @submit.prevent="decide('declined')">
        <p>{{ t('interview.decline.title') }}</p>
        <fieldset class="stack">
          <legend class="label">{{ t('interview.decline.choose') }}</legend>
          <label class="radio">
            <input type="radio" name="alternative" :value="alternative" checked>
            <span>{{ alternative === 'text_form' ? t('interview.decline.textForm') : t('interview.decline.human') }}</span>
          </label>
        </fieldset>
        <label v-if="alternative === 'human_interview'" class="stack">
          <span class="label">{{ t('interview.decline.preferredTime') }}</span>
          <input v-model="preferredTime" class="field" maxlength="200" :placeholder="t('interview.decline.preferredTimeHint')">
        </label>
        <div class="actions">
          <button class="btn primary" type="submit" :disabled="busy">{{ t('interview.decline.send') }}</button>
          <button class="btn ghost" type="button" :disabled="busy" @click="phase = 'consent'">{{ t('interview.decline.back') }}</button>
        </div>
      </form>

      <!-- §5.2 Крок 0: перевірка мікрофона -->
      <section v-else-if="phase === 'mic'" class="card stack">
        <p>{{ entry.scenario.introText }}</p>
        <template v-if="allowsVoice">
          <h2 class="h2">{{ t('interview.mic.title') }}</h2>
          <p v-if="micState !== 'denied'">{{ t('interview.mic.say') }}</p>
          <div v-if="micState === 'ok'" class="meter" role="meter" :aria-label="t('interview.mic.level')" aria-valuemin="0" aria-valuemax="100" :aria-valuenow="Math.round(level * 100)">
            <span class="meter-fill" :style="{ transform: `scaleX(${level})` }" />
          </div>
          <p v-if="micState === 'denied'" class="note sun" role="status">
            {{ allowsText ? t('interview.mic.denied') : t('interview.mic.deniedNoText') }}
          </p>
          <div class="actions">
            <button v-if="micState === 'idle' || micState === 'checking'" class="btn primary" type="button" :disabled="micState === 'checking'" @click="checkMic">{{ t('interview.mic.check') }}</button>
            <button v-if="micState === 'ok'" class="btn primary" type="button" :disabled="busy" @click="start('voice')">{{ t('interview.mic.works') }}</button>
            <button v-if="allowsText" class="btn ghost" type="button" :disabled="busy" @click="start('text')">{{ t('interview.mic.useText') }}</button>
            <button v-if="micState === 'denied' && !allowsText" class="btn ghost" type="button" :disabled="busy" @click="noMicrophone">{{ t('interview.alternative.continue') }}</button>
          </div>
        </template>
        <div v-else class="actions">
          <button class="btn primary" type="button" :disabled="busy" @click="start('text')">{{ t('interview.mic.start') }}</button>
        </div>
      </section>

      <!-- ШІ недоступний або немає мікрофона: альтернатива сценарію (§7.12, §12 п. 1) -->
      <section v-else-if="phase === 'unavailable'" class="card stack">
        <h2 class="h2">{{ t('interview.alternative.unavailable') }}</h2>
        <template v-if="alternative === 'text_form'">
          <p>{{ t('interview.alternative.unavailableForm') }}</p>
          <div class="actions">
            <button class="btn primary" type="button" :disabled="busy" @click="takeAlternative">{{ t('interview.alternative.openForm') }}</button>
          </div>
        </template>
        <form v-else class="stack" @submit.prevent="takeAlternative">
          <p>{{ t('interview.alternative.unavailableText') }}</p>
          <label class="stack">
            <span class="label">{{ t('interview.decline.preferredTime') }}</span>
            <input v-model="preferredTime" class="field" maxlength="200" :placeholder="t('interview.decline.preferredTimeHint')">
          </label>
          <div class="actions">
            <button class="btn primary" type="submit" :disabled="busy">{{ t('interview.decline.send') }}</button>
          </div>
        </form>
      </section>

      <section v-else-if="phase === 'waiting'" class="card stack" role="status">
        <h2 class="h2">{{ t('interview.decline.sent') }}</h2>
        <p>{{ t('interview.alternative.waiting') }}</p>
      </section>

      <!-- Письмова форма: ті самі питання текстом, без запису (§6.3) -->
      <section v-else-if="phase === 'text_form' && form" class="stack">
        <div class="card stack">
          <h2 class="h2">{{ t('interview.textForm.title') }}</h2>
          <p class="muted">{{ t('interview.textForm.hint') }}</p>
        </div>
        <p v-if="form.status !== 'in_progress'" class="note teal" role="status">{{ t('interview.textForm.submitted') }}</p>
        <form v-else class="stack" @submit.prevent="submitForm">
          <label v-for="q in form.questions" :key="q.id" class="card stack">
            <span class="label">{{ t('interview.session.question', { n: q.ordinal, total: form.questions.length }) }}</span>
            <span>{{ stemText(q.stem) }}</span>
            <textarea v-model="q.answer" class="field" rows="5" maxlength="5000" @blur="saveAnswer(q.id, q.answer)" />
            <span v-if="saved[q.id]" class="help">{{ t('interview.textForm.saved') }}</span>
          </label>
          <div class="sticky-bottom">
            <button class="btn primary" type="submit" :disabled="busy">{{ t('interview.textForm.submit') }}</button>
          </div>
        </form>
      </section>

      <section v-else-if="phase === 'withdrawn'" class="card" role="status">
        <p>{{ t('interview.session.withdrawn') }}</p>
      </section>

      <section v-else-if="phase === 'done'" class="card stack" role="status">
        <h2 class="h2">{{ t('interview.session.doneTitle') }}</h2>
        <p>{{ t('interview.session.doneText') }}</p>
        <p v-if="entry.lastSession?.needsHuman" class="muted">{{ t('interview.session.degraded') }}</p>
      </section>
    </template>
  </main>
</template>

<style scoped>
.interview { max-width: 40rem; margin: 0 auto; padding: var(--space-5) var(--space-4) var(--space-7); display: grid; gap: var(--space-4); }
.head h1 { margin: 0; font-size: var(--font-size-title-l); font-weight: 900; }
.eyebrow { margin: 0 0 var(--space-1); color: var(--color-ink-muted); font-weight: 700; font-size: var(--font-size-body-s); }
.stack { display: grid; gap: var(--space-3); }
.h2 { margin: 0; font-size: var(--font-size-body); font-weight: 900; }
.lines { list-style: none; margin: 0; padding: 0; display: grid; gap: var(--space-3); }
.lines li { display: flex; gap: var(--space-3); align-items: flex-start; }
.dot { flex: none; width: var(--space-3); height: var(--space-3); margin-top: var(--space-1); border-radius: var(--radius-pill); background: var(--color-teal); }
.full { border-top: 1px solid var(--color-bg-line-soft); padding-top: var(--space-3); color: var(--color-ink-muted); font-size: var(--font-size-body-s); }
.actions { display: flex; flex-wrap: wrap; gap: var(--space-2); }
.big { padding: var(--space-3) var(--space-5); font-size: var(--font-size-body); }
.link-btn { font: inherit; font-weight: 700; color: var(--color-teal-ink); background: none; border: none; padding: 0; cursor: pointer; justify-self: start; text-decoration: underline; }
.radio { display: flex; gap: var(--space-2); align-items: flex-start; }
fieldset { border: none; margin: 0; padding: 0; }
.meter { height: var(--space-3); border-radius: var(--radius-pill); background: var(--color-bg-line-soft); overflow: hidden; }
.meter-fill { display: block; height: 100%; background: var(--color-teal); transform-origin: left center; transition: transform 0.1s; }
.skeleton { height: var(--space-4); margin: var(--space-2) 0; border-radius: var(--radius-s); background: var(--color-bg-line-soft); }
@media (max-width: 480px) {
  .actions { flex-direction: column; }
  .actions .btn { width: 100%; justify-content: center; white-space: normal; }
}
</style>
