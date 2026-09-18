<script setup lang="ts">
import type { ContentBlock } from '../../../../shared/schemas/content'

definePageMeta({ layout: false })

const { t } = useI18n()
const { api } = useApi()
const route = useRoute()
const quizId = route.params.quizId as string
const enrollmentId = (route.query.enrollmentId as string) || undefined
const lessonId = (route.query.lessonId as string) || undefined

interface Intro {
  title: string
  description: ContentBlock[] | null
  questionCount: number
  timeLimitSec: number | null
  passScore: number
  attemptsAllowed: number
  attemptsLeft: number | null
  activeAttemptId: string | null
  lastPassed: boolean
}
interface Q { id: string, kind: string, stem: ContentBlock[], options: unknown, isCritical: boolean, points: number, answered: boolean }
interface State {
  id: string
  status: string
  secondsLeft: number | null
  params: { allowSkip: boolean, allowBack: boolean, requireAllAnswered: boolean, showAnswers: string, passScore: number }
  questions: Q[]
  answers: Record<string, unknown>
}
interface Result {
  status: string
  score: number | null
  passScore: number
  passed: boolean | null
  questions: { id: string, kind: string, stem: ContentBlock[], isCritical: boolean, yourAnswer: unknown, isCorrect: boolean | null, score: number, points: number, explanation?: ContentBlock[] | null, reviewComment: string | null }[]
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
onMounted(loadIntro)

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

const backTo = computed(() => enrollmentId ? `/learn/${enrollmentId}` : '/learn')
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
        <p v-else class="exhausted">{{ t('quiz.exhausted') }}</p>
      </template>

      <!-- Вопрос -->
      <template v-else-if="phase === 'question' && current">
        <span v-if="current.isCritical" class="critical">{{ t('quiz.critical') }}</span>
        <LessonBlocks :blocks="current.stem" :blocks-state="{}" readonly />
        <QuestionInput
          v-model="answers[current.id]"
          :kind="current.kind"
          :options="current.options"
        />
      </template>

      <!-- Результат -->
      <template v-else-if="phase === 'result' && result">
        <div v-if="result.status === 'review'" class="review">
          <h1>{{ t('quiz.onReview') }}</h1>
          <p>{{ t('quiz.onReviewHint') }}</p>
        </div>
        <template v-else>
          <div :class="['score', result.passed ? 'teal' : 'coral']">{{ result.score ?? '—' }}%</div>
          <p class="pass-line">{{ t('quiz.passLine', { pass: result.passScore }) }}</p>
          <p class="verdict">{{ result.passed ? t('quiz.passed') : t('quiz.failed') }}</p>
        </template>

        <div class="breakdown">
          <div v-for="(q, i) in result.questions" :key="q.id" :class="['item', q.isCorrect === true ? 'ok' : q.isCorrect === false ? 'bad' : 'pending']">
            <div class="item-head">
              <span>{{ i + 1 }}. {{ q.isCorrect === true ? '✓' : q.isCorrect === false ? '✕' : '…' }}</span>
              <span class="pts">{{ q.score }} / {{ q.points }}</span>
            </div>
            <LessonBlocks :blocks="q.stem" :blocks-state="{}" readonly />
            <div v-if="q.explanation?.length" class="expl">
              <LessonBlocks :blocks="q.explanation" :blocks-state="{}" readonly />
            </div>
            <p v-if="q.reviewComment" class="comment">{{ q.reviewComment }}</p>
          </div>
        </div>

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
        <button
          v-if="index < total - 1"
          class="primary"
          :disabled="busy || (!state.params.allowSkip && answers[current!.id] === undefined)"
          @click="next"
        >
          {{ t('learner.next') }}
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
