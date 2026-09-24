<script setup lang="ts">
import type { ContentBlock } from '../../../../shared/schemas/content'

definePageMeta({ layout: false })

const { t } = useI18n()
const { api } = useApi()
const bonusText = useBonusText()
const route = useRoute()
const quizId = route.params.quizId as string
const enrollmentId = (route.query.enrollmentId as string) || undefined
const lessonId = (route.query.lessonId as string) || undefined
// Часть комплексного теста (docs/18 §5.5): попытка уже создана, после результата — назад в комплекс
const complexAttemptId = (route.query.complexAttemptId as string) || undefined
const presetAttemptId = (route.query.attemptId as string) || undefined

interface Intro {
  title: string
  description: ContentBlock[] | null
  questionCount: number
  timeLimitSec: number | null
  passScore: number
  attemptsAllowed: number
  attemptsUsed: number
  attemptsLeft: number | null
  pendingRequestId: string | null
  activeAttemptId: string | null
  lastPassed: boolean
}
interface Q { id: string, kind: string, stem: ContentBlock[], options: unknown, isCritical: boolean, points: number, answered: boolean, attachFiles?: boolean }
interface State {
  id: string
  status: string
  secondsLeft: number | null
  params: { allowSkip: boolean, allowBack: boolean, requireAllAnswered: boolean, showAnswers: string, passScore: number }
  questions: Q[]
  answers: Record<string, unknown>
}
interface ResultQ { id: string, kind: string, stem: ContentBlock[], options: unknown, isCritical: boolean, yourAnswer: unknown, isCorrect: boolean | null, score: number, points: number, answer?: unknown, explanation?: ContentBlock[] | null, reviewComment: string | null }
interface Result {
  status: string
  score: number | null
  passScore: number
  passed: boolean | null
  attemptNo: number
  attemptsAllowed: number
  attemptsLeft: number | null
  earned: number
  maxScore: number
  protocol: 'shown' | 'hidden' | 'after_last_attempt'
  questions: ResultQ[]
  /** Мокап TestResult: бонуси за це завдання, якщо їх нарахувала саме ця спроба (docs/33 D-069). */
  bonus: { earned: number, balance: number } | null
}

type Phase = 'intro' | 'question' | 'result'
const phase = ref<Phase>('intro')
const intro = ref<Intro | null>(null)
const state = ref<State | null>(null)
const result = ref<Result | null>(null)
const index = ref(0)
const answers = ref<Record<string, unknown>>({})
const error = ref('')
const busy = ref(false)
const secondsLeft = ref<number | null>(null)
const requestReason = ref('')
const requestSent = ref(false)
const files = ref<Record<string, { name: string }[]>>({})
const { upload, compressImage } = useMediaUpload()

const current = computed(() => state.value?.questions[index.value] ?? null)
const total = computed(() => state.value?.questions.length ?? 0)
const answeredCount = computed(() => Object.keys(answers.value).length)

let timer: ReturnType<typeof setInterval> | undefined
onUnmounted(() => clearInterval(timer))

async function loadIntro() {
  try {
    intro.value = await api<Intro>(`/learning/quizzes/${quizId}`, { query: enrollmentId ? { enrollmentId } : {} })
  }
  catch (err) {
    error.value = apiErrorOf(err).message
  }
}
onMounted(async () => {
  if (presetAttemptId && complexAttemptId) { await loadState(presetAttemptId); return }
  await loadIntro()
})

async function start() {
  busy.value = true
  error.value = ''
  try {
    const r = await api<{ attemptId: string }>(`/learning/quizzes/${quizId}/attempts`, {
      method: 'POST',
      body: { enrollmentId, lessonId, device: window.innerWidth < 768 ? 'mobile' : 'desktop' },
    })
    await loadState(r.attemptId)
  }
  catch (err) {
    error.value = apiErrorOf(err).message
  }
  finally {
    busy.value = false
  }
}

async function loadState(attemptId: string) {
  state.value = await api<State>(`/attempts/${attemptId}`)
  answers.value = { ...state.value.answers }
  const firstUnanswered = state.value.questions.findIndex(q => !q.answered)
  index.value = firstUnanswered >= 0 ? firstUnanswered : 0
  phase.value = 'question'
  secondsLeft.value = state.value.secondsLeft
  clearInterval(timer)
  if (secondsLeft.value !== null) {
    timer = setInterval(() => {
      if (secondsLeft.value === null) return
      secondsLeft.value = Math.max(0, secondsLeft.value - 1)
      if (secondsLeft.value === 0) {
        clearInterval(timer)
        submit()
      }
    }, 1000)
  }
}

/** «Попросити ще одну спробу» прямо с экрана исчерпанных попыток (docs/12 §14.5). */
async function requestAttempt() {
  busy.value = true
  error.value = ''
  try {
    await api(`/tests/${quizId}/attempt-requests`, { method: 'POST', body: { reason: requestReason.value.trim(), enrollmentId } })
    requestSent.value = true
    await loadIntro()
  }
  catch (err) {
    error.value = apiErrorOf(err).message
  }
  finally {
    busy.value = false
  }
}

/** Вложение к свободному ответу: файл → /media → привязка к ответу (docs/04 §4.6). */
async function attach(e: Event) {
  const file = (e.target as HTMLInputElement).files?.[0]
  if (!file || !current.value || !state.value) return
  busy.value = true
  error.value = ''
  try {
    const blob = await compressImage(file)
    const mediaId = await upload(blob, file.name, 'workshop_submission', { sourceEntity: 'attempts', sourceId: state.value.id })
    const r = await api<{ files: { name: string }[] }>(`/attempts/${state.value.id}/answers/${current.value.id}/files`, {
      method: 'POST',
      body: { mediaId, name: file.name, kind: file.type.startsWith('image/') ? 'photo' : file.type.startsWith('video/') ? 'video' : 'file', bytes: blob.size },
    })
    files.value[current.value.id] = r.files
  }
  catch (err) {
    error.value = apiErrorOf(err).message
  }
  finally {
    busy.value = false
  }
}

async function skip() {
  if (index.value < total.value - 1) index.value++
}

/** Ответ текстом — для протокола помилок «Ви відповіли …, правильно — …». */
function answerLabel(q: ResultQ, a: unknown): string {
  const opts = (Array.isArray(q.options) ? q.options : []) as { id: string, text: string }[]
  const o = (a ?? {}) as Record<string, unknown>
  const byId = (id: string) => opts.find(x => x.id === id)?.text ?? id
  switch (q.kind) {
    case 'single': return byId(String(o.optionId ?? o.correctId ?? ''))
    case 'multi': return (((o.optionIds ?? o.correctIds) as string[] | undefined) ?? []).map(byId).join(', ')
    case 'number': return String(o.value ?? '')
    case 'text_short': return String(o.text ?? ((o.accepted as string[] | undefined) ?? [])[0] ?? '')
    case 'free': return String(o.text ?? '')
    case 'cloze': return Object.values((o.values as Record<string, string> | undefined) ?? {}).join(', ')
    default: return a == null ? '' : t('quiz.answerGiven')
  }
}

async function saveCurrent() {
  if (!current.value || !state.value) return
  const a = answers.value[current.value.id]
  if (a === undefined) return
  try {
    await api(`/attempts/${state.value.id}/answers/${current.value.id}`, { method: 'PUT', body: { answer: a } })
  }
  catch (err) {
    error.value = apiErrorOf(err).message
  }
}

async function next() {
  await saveCurrent()
  if (index.value < total.value - 1) index.value++
}
function back() {
  if (index.value > 0) index.value--
}

async function submit() {
  if (!state.value) return
  busy.value = true
  error.value = ''
  try {
    await saveCurrent()
    await api(`/attempts/${state.value.id}/submit`, { method: 'POST' })
    result.value = await api<Result>(`/attempts/${state.value.id}/result`)
    phase.value = 'result'
    clearInterval(timer)
    await loadIntro()
  }
  catch (err) {
    error.value = apiErrorOf(err).message
  }
  finally {
    busy.value = false
  }
}

function fmtTime(s: number) {
  return `${Math.floor(s / 60)}:${String(s % 60).padStart(2, '0')}`
}

const backTo = computed(() => complexAttemptId ? `/learn/complex/${route.query.complexId}?attemptId=${complexAttemptId}` : enrollmentId ? `/learn/${enrollmentId}` : '/learn')
const mistakes = computed(() => (result.value?.questions ?? []).filter(q => q.isCorrect === false))
const canRetry = computed(() => !!intro.value && !intro.value.activeAttemptId && (intro.value.attemptsLeft === null || intro.value.attemptsLeft > 0))
function retry() {
  result.value = null
  state.value = null
  answers.value = {}
  phase.value = 'intro'
}
</script>

<template>
  <div class="quiz">
    <header class="top">
      <NuxtLink :to="backTo" class="close">✕</NuxtLink>
      <div class="crumbs">
        <div class="title">{{ intro?.title }}</div>
        <div v-if="phase === 'question'" class="pos">{{ t('quiz.questionOf', { n: index + 1, total }) }}</div>
      </div>
      <div v-if="phase === 'question' && secondsLeft !== null" :class="['timer', { urgent: secondsLeft <= 60 }]">
        {{ fmtTime(secondsLeft) }}
      </div>
    </header>

    <main class="body">
      <p v-if="error" class="error">{{ error }}</p>

      <!-- Стартовый экран (docs/12 §5.4) -->
      <template v-if="phase === 'intro' && intro">
        <h1>{{ intro.title }}</h1>
        <LessonBlocks v-if="intro.description?.length" :blocks="intro.description" :blocks-state="{}" readonly />
        <dl class="facts">
          <dt>{{ t('quiz.questions') }}</dt><dd>{{ intro.questionCount }}</dd>
          <dt>{{ t('quiz.timeLimit') }}</dt><dd>{{ intro.timeLimitSec ? fmtTime(intro.timeLimitSec) : t('quiz.noLimit') }}</dd>
          <dt>{{ t('quiz.passScore') }}</dt><dd>{{ intro.passScore }}%</dd>
          <dt>{{ t('quiz.attempts') }}</dt>
          <dd>{{ intro.attemptsLeft === null ? t('quiz.unlimited') : t('quiz.attemptsLeft', { left: intro.attemptsLeft, total: intro.attemptsAllowed }) }}</dd>
        </dl>
        <button
          v-if="intro.activeAttemptId"
          class="primary"
          :disabled="busy"
          @click="loadState(intro.activeAttemptId!)"
        >
          {{ t('quiz.resume') }}
        </button>
        <button
          v-else-if="intro.attemptsLeft === null || intro.attemptsLeft > 0"
          class="primary"
          :disabled="busy"
          @click="start"
        >
          {{ t('quiz.start') }}
        </button>
        <template v-else>
          <p class="exhausted">{{ t('quiz.exhausted') }}</p>
          <p v-if="intro.pendingRequestId || requestSent" class="note sun">{{ t('quiz.requestPending') }}</p>
          <form v-else class="request" @submit.prevent="requestAttempt">
            <label class="label" for="request-reason">{{ t('quiz.requestReason') }}</label>
            <textarea id="request-reason" v-model="requestReason" class="field" rows="3" minlength="10" maxlength="300" :placeholder="t('quiz.requestReasonPh')" />
            <button class="primary" type="submit" :disabled="busy || requestReason.trim().length < 10">{{ t('quiz.requestAttempt') }}</button>
          </form>
        </template>
      </template>

      <!-- Вопрос -->
      <template v-else-if="phase === 'question' && current">
        <span v-if="current.isCritical" class="critical">{{ t('quiz.critical') }}</span>
        <!-- cloze (докс/33 D-015): текст із пропусками показує сам QuestionInput -->
        <LessonBlocks v-if="current.kind !== 'cloze'" :blocks="current.stem" :blocks-state="{}" readonly />
        <div class="kind-line">
          <span>{{ t(`quiz.kindHint.${current.kind}`) }} · {{ t('quiz.pointsN', { n: current.points }) }}</span>
          <!--
            Флажок у вопроса (docs/v2/36 §5.1): всегда виден, варианты ответа не перекрывает.
            Жалоба не прерывает попытку и не съедает таймер — время в форме сервер вернёт
            сдвигом дедлайна (§7.7); ответ оценивается по снапшоту, как и был.
          -->
          <ContentIssueReport
            v-if="state"
            compact
            target-type="question"
            :target-id="current.id"
            source="attempt"
            :enrollment-id="enrollmentId"
            :lesson-id="lessonId"
            :attempt-id="state.id"
            :where-label="t('issue.whereQuestion', { n: index + 1 })"
          />
        </div>
        <QuestionInput
          v-model="answers[current.id]"
          :kind="current.kind"
          :options="current.options"
          :stem="current.stem"
        />
        <div v-if="current.kind === 'file' || (current.kind === 'free' && current.attachFiles)" class="attach">
          <label class="ghost attach-btn">
            {{ t('quiz.attachFile') }}
            <input type="file" accept="image/*,video/*,application/pdf" capture="environment" hidden :disabled="busy" @change="attach">
          </label>
          <span v-for="f in files[current.id] ?? []" :key="f.name" class="file-chip">{{ f.name }}</span>
        </div>
      </template>

      <!-- Результат -->
      <template v-else-if="phase === 'result' && result">
        <div v-if="result.status === 'review'" class="review">
          <h1>{{ t('quiz.onReview') }}</h1>
          <p>{{ t('quiz.onReviewHint') }}</p>
        </div>
        <div v-else :class="['result-card', result.passed ? 'teal' : 'coral']">
          <div class="badge-icon" aria-hidden="true">
            <svg v-if="result.passed" width="34" height="34" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="3" stroke-linecap="round" stroke-linejoin="round"><path d="M4 12.5l5 5L20 6.5" /></svg>
            <svg v-else width="30" height="30" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="3" stroke-linecap="round" stroke-linejoin="round"><path d="M6 6l12 12M18 6L6 18" /></svg>
          </div>
          <div :class="['score', result.passed ? 'teal' : 'coral']">{{ result.score ?? '—' }}%</div>
          <p class="verdict">{{ result.passed ? t('quiz.passed') : t('quiz.failed') }}</p>
          <p class="pass-line">
            {{ t('quiz.thresholdLine', { pass: result.passScore, earned: result.earned, max: result.maxScore }) }}
            · {{ result.attemptsAllowed > 0 ? t('quiz.attemptOf', { n: result.attemptNo, total: result.attemptsAllowed }) : t('quiz.attemptN', { n: result.attemptNo }) }}
          </p>
        </div>

        <p v-if="result.bonus" class="note sun bonus-plate" role="status">
          <b>{{ t('quiz.bonusEarned', { amount: bonusText(result.bonus.earned) }) }}</b>
          <span>{{ t('quiz.bonusBalance', { amount: bonusText(result.bonus.balance) }) }}</span>
        </p>

        <p v-if="result.protocol === 'after_last_attempt'" class="note sun">{{ t('quiz.protocolAfterLast') }}</p>

        <template v-if="result.protocol === 'shown' && result.status !== 'review'">
          <h2 class="mistakes-title">{{ t('quiz.mistakes', { n: mistakes.length }) }}</h2>
          <div class="breakdown">
            <div v-for="q in mistakes" :key="q.id" class="item bad">
              <LessonBlocks :blocks="q.stem" :blocks-state="{}" readonly />
              <p class="compare">
                <span v-if="answerLabel(q, q.yourAnswer)">{{ t('quiz.youAnswered', { a: answerLabel(q, q.yourAnswer) }) }}</span>
                <span v-else>{{ t('quiz.noAnswer') }}</span>
                <span v-if="q.answer !== undefined && answerLabel(q, q.answer)">, {{ t('quiz.correctIs', { a: answerLabel(q, q.answer) }) }}</span>
              </p>
              <span v-if="q.isCritical" class="critical">{{ t('quiz.critical') }}</span>
              <div v-if="q.explanation?.length" class="expl">
                <LessonBlocks :blocks="q.explanation" :blocks-state="{}" readonly />
              </div>
              <p v-if="q.reviewComment" class="comment">{{ q.reviewComment }}</p>
            </div>
          </div>
        </template>

        <button v-if="canRetry && result.passed !== true" class="ghost" @click="retry">{{ t('quiz.retry') }}</button>
        <NuxtLink :to="backTo" class="primary link">{{ t('quiz.backToLearning') }}</NuxtLink>
      </template>
    </main>

    <footer v-if="phase === 'question' && state" class="bottom">
      <div class="progress">
        <div class="bar" :style="{ width: `${answeredCount / total * 100}%` }" />
      </div>
      <div class="row">
        <button v-if="state.params.allowBack" class="ghost" :disabled="index === 0" @click="back">{{ t('quiz.back') }}</button>
        <span class="spacer" />
        <button v-if="state.params.allowSkip && index < total - 1" class="ghost" :disabled="busy" @click="skip">{{ t('quiz.skip') }}</button>
        <button
          v-if="index < total - 1"
          class="primary"
          :disabled="busy || answers[current!.id] === undefined"
          @click="next"
        >
          {{ t('quiz.answer') }}
        </button>
        <button
          v-else
          class="primary"
          :disabled="busy || (state.params.requireAllAnswered && answeredCount < total)"
          @click="submit"
        >
          {{ t('quiz.submit') }}
        </button>
      </div>
    </footer>
  </div>
</template>

<style scoped>
.quiz {
  min-height: 100dvh;
  display: flex;
  flex-direction: column;
  background: var(--color-bg);
  font-family: var(--font-family);
  color: var(--color-ink);
}

.top {
  display: flex;
  align-items: center;
  gap: var(--space-3);
  padding: var(--space-3) var(--space-4);
  background: var(--color-bg-soft);
  border-bottom: 1px solid var(--color-bg-line);
  position: sticky;
  top: 0;
}

.close {
  width: 36px;
  height: 36px;
  display: grid;
  place-items: center;
  border-radius: var(--radius-pill);
  background: var(--color-bg);
  color: var(--color-ink);
  text-decoration: none;
  font-weight: 800;
}

.crumbs {
  flex: 1;
}

.title {
  font-weight: 800;
  font-size: var(--font-size-body-s);
}

.pos {
  font-size: var(--font-size-body-s);
  color: var(--color-ink-muted);
}

.timer {
  font-weight: 900;
  font-variant-numeric: tabular-nums;
}

.timer.urgent {
  color: var(--color-coral-ink);
}

.body {
  flex: 1;
  padding: var(--space-4);
  padding-bottom: 120px;
  max-width: 720px;
  width: 100%;
  margin: 0 auto;
  box-sizing: border-box;
  display: grid;
  gap: var(--space-4);
  align-content: start;
}

h1 {
  margin: 0;
  font-weight: 900;
}

.facts {
  display: grid;
  grid-template-columns: auto 1fr;
  gap: var(--space-2) var(--space-4);
  margin: 0;
  background: var(--color-bg-soft);
  border-radius: var(--radius-m);
  padding: var(--space-4);
}

dt {
  color: var(--color-ink-muted);
}

dd {
  margin: 0;
  font-weight: 700;
}

.primary,
.ghost {
  font: inherit;
  font-weight: 800;
  border: none;
  border-radius: var(--radius-pill);
  padding: var(--space-3) var(--space-6);
  cursor: pointer;
  text-decoration: none;
  text-align: center;
}

.primary {
  background: var(--color-sun);
  color: var(--color-ink);
}

.primary:disabled {
  opacity: 0.4;
}

.ghost {
  background: transparent;
  border: 1px solid var(--color-bg-line);
  color: var(--color-ink-muted);
}

.link {
  display: block;
}

.exhausted {
  color: var(--color-coral-ink);
  font-weight: 700;
}

.request {
  display: grid;
  gap: var(--space-2);
}

.kind-line {
  margin: 0;
  color: var(--color-ink-muted);
  font-size: var(--font-size-body-s);
  font-weight: 700;
  display: flex;
  align-items: center;
  justify-content: space-between;
  gap: var(--space-2);
  flex-wrap: wrap;
}

.attach {
  display: flex;
  gap: var(--space-2);
  flex-wrap: wrap;
  align-items: center;
}

.attach-btn {
  cursor: pointer;
}

.file-chip {
  font-size: var(--font-size-body-s);
  background: var(--color-bg-soft);
  border-radius: var(--radius-pill);
  padding: var(--space-1) var(--space-3);
}

.result-card {
  /* Мокап TestResult: нейтральна картка з кольоровою рамкою й бейджем-іконкою,
     а не суцільна заливка кольором стану (docs/12 §14) */
  background: var(--color-bg-soft);
  border: 2px solid transparent;
  border-radius: var(--radius-l);
  padding: var(--space-6) var(--space-5);
  text-align: center;
  display: grid;
  justify-items: center;
  gap: var(--space-2);
}

.bonus-plate { display: flex; justify-content: space-between; align-items: center; flex-wrap: wrap; gap: var(--space-2); }
.result-card.teal { border-color: var(--color-teal); }
.result-card.coral { border-color: var(--color-coral); }

.badge-icon {
  width: 72px;
  height: 72px;
  border-radius: var(--radius-pill);
  display: grid;
  place-items: center;
  margin-bottom: var(--space-2);
}
.result-card.teal .badge-icon { background: var(--color-teal); color: var(--color-teal-deep); }
.result-card.coral .badge-icon { background: var(--color-coral); color: var(--color-coral-deep); }

.mistakes-title {
  margin: 0;
  font-size: var(--font-size-title-l);
  font-weight: 900;
}

.compare {
  margin: 0;
}

.critical {
  justify-self: start;
  font-size: var(--font-size-body-s);
  font-weight: 800;
  background: var(--color-coral);
  color: var(--color-coral-deep);
  border-radius: var(--radius-pill);
  padding: 2px var(--space-3);
}

.score {
  font-size: 4rem;
  font-weight: 900;
  text-align: center;
  line-height: 1;
}

.score.teal {
  color: var(--color-teal-ink);
}

.score.coral {
  color: var(--color-coral-ink);
}

.pass-line {
  margin: 0;
  text-align: center;
  color: var(--color-ink-muted);
}

.verdict {
  margin: 0;
  text-align: center;
  font-weight: 900;
  font-size: var(--font-size-title-l);
}

.review {
  text-align: center;
  color: var(--color-ink-muted);
}

.breakdown {
  display: grid;
  gap: var(--space-3);
}

.item {
  background: var(--color-bg-soft);
  border-radius: var(--radius-m);
  padding: var(--space-3) var(--space-4);
  border-left: 4px solid var(--color-bg-line);
  display: grid;
  gap: var(--space-2);
}

.item.ok {
  border-color: var(--color-teal);
}

.item.bad {
  border-color: var(--color-coral);
}

.item-head {
  display: flex;
  justify-content: space-between;
  font-weight: 800;
}

.pts {
  color: var(--color-ink-faint);
  font-weight: 400;
  font-size: var(--font-size-body-s);
}

.expl {
  border-top: 1px solid var(--color-bg-line-soft);
  padding-top: var(--space-2);
  color: var(--color-ink-muted);
}

.comment {
  margin: 0;
  font-style: italic;
  color: var(--color-teal-ink);
}

.bottom {
  position: fixed;
  bottom: 0;
  left: 0;
  right: 0;
  background: var(--color-bg-soft);
  border-top: 1px solid var(--color-bg-line);
  padding-bottom: env(safe-area-inset-bottom);
}

.progress {
  height: 4px;
  background: var(--color-bg-line-soft);
}

.bar {
  height: 100%;
  background: var(--color-teal);
}

.row {
  display: flex;
  align-items: center;
  gap: var(--space-3);
  padding: var(--space-3) var(--space-4);
  max-width: 720px;
  margin: 0 auto;
}

.spacer {
  flex: 1;
}

.error {
  color: var(--color-coral-ink);
}
</style>
