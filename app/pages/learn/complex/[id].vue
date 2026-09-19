<script setup lang="ts">
definePageMeta({ layout: 'learner' })
const { t } = useI18n()
const { api } = useApi()
const route = useRoute()
interface Intro { id: string, title: string, passScore: number, timeLimitSec: number | null, sequential: boolean, attemptsAllowed: number, showPartsResult: boolean, parts: { index: number, quizId: string, title: string, weight: number, minScore: number | null }[], attemptsUsed: number, active: { id: string } | null, last: { id: string, status: string, score: string | null, passed: boolean | null } | null }
interface State { id: string, status: string, score: number | null, passed: boolean | null, partsState: { quizId: string, attemptId: string | null, score: number | null, status: string }[], expiresAt: string | null, showPartsResult: boolean, passScore: number }
const intro = ref<Intro | null>(null)
const state = ref<State | null>(null)
const error = ref('')
const now = ref(Date.now())
let timer: ReturnType<typeof setInterval> | null = null
async function load() {
  try {
    intro.value = await api<Intro>(`/complex-tests/${route.params.id}`)
    const attemptId = (route.query.attemptId as string) || intro.value.active?.id || intro.value.last?.id
    state.value = attemptId ? await api<State>(`/complex-attempts/${attemptId}`) : null
  } catch (err) { error.value = apiErrorOf(err).message }
}
onMounted(() => { load(); timer = setInterval(() => { now.value = Date.now() }, 1000) })
onUnmounted(() => { if (timer) clearInterval(timer) })
async function start() {
  error.value = ''
  try { const r = await api<{ attemptId: string }>(`/complex-tests/${route.params.id}/attempts`, { method: 'POST' }); await navigateTo({ query: { attemptId: r.attemptId } }); await load() }
  catch (err) { const e = apiErrorOf(err); if (e.code === 'complex.in_progress' && e.details?.attemptId) { await navigateTo({ query: { attemptId: String(e.details.attemptId) } }); await load() } else error.value = e.message }
}
async function open(quizId: string) {
  error.value = ''
  try {
    const r = await api<{ attemptId: string }>(`/complex-attempts/${state.value!.id}/parts`, { method: 'POST', body: { quizId } })
    await navigateTo(`/learn/quiz/${quizId}?attemptId=${r.attemptId}&complexAttemptId=${state.value!.id}&complexId=${route.params.id}`)
  } catch (err) { error.value = apiErrorOf(err).message }
}
const timeLeft = computed(() => { if (!state.value?.expiresAt) return null; const s = Math.max(0, Math.floor((new Date(state.value.expiresAt).getTime() - now.value) / 1000)); return `${Math.floor(s / 60)}:${String(s % 60).padStart(2, '0')}` })
const current = computed(() => state.value?.partsState.findIndex(p => p.status === 'pending' || p.status === 'in_progress') ?? -1)
const partTitle = (quizId: string) => intro.value?.parts.find(p => p.quizId === quizId)
</script>
<template>
  <div>
    <NuxtLink to="/learn" class="back">← {{ t('learner.nav.learning') }}</NuxtLink>
    <p v-if="error" class="error">{{ error }}</p>
    <template v-if="intro">
      <h1>{{ intro.title }}</h1>
      <!-- Стартовый экран (docs/18 §5.5) -->
      <section v-if="!state || (state.status !== 'in_progress' && !intro.active)" class="card">
        <p>{{ t('cx.intro', { n: intro.parts.length, pass: intro.passScore }) }}<template v-if="intro.timeLimitSec"> · {{ t('cx.limit', { min: Math.round(intro.timeLimitSec / 60) }) }}</template></p>
        <ol class="parts"><li v-for="p in intro.parts" :key="p.quizId">{{ p.title }} <span class="sub">×{{ p.weight }}<template v-if="p.minScore != null"> · {{ t('cx.minScore', { n: p.minScore }) }}</template></span></li></ol>
        <div v-if="state && state.status !== 'in_progress'" :class="['result', state.passed ? 'ok' : 'bad']">
          <b>{{ state.score }}%</b> {{ state.passed ? t('cx.passed') : state.status === 'expired' ? t('cx.expired') : t('cx.failed') }}
          <ul v-if="state.showPartsResult" class="parts small"><li v-for="p in state.partsState" :key="p.quizId">{{ partTitle(p.quizId)?.title }}: <b>{{ p.score ?? '—' }}%</b> <span :class="['badge', p.status]">{{ t(`cx.part.${p.status}`) }}</span></li></ul>
          <p v-if="!state.passed && state.showPartsResult" class="sub">{{ t('cx.improve') }}: {{ state.partsState.filter(p => p.status === 'failed').map(p => partTitle(p.quizId)?.title).join(', ') }}</p>
        </div>
        <button class="primary" :disabled="intro.attemptsAllowed > 0 && intro.attemptsUsed >= intro.attemptsAllowed" data-testid="cx-start" @click="start">{{ t('cx.start') }}</button>
        <p class="sub">{{ t('cx.attempts', { used: intro.attemptsUsed, total: intro.attemptsAllowed || '∞' }) }}</p>
      </section>
      <!-- Внутри комплекса -->
      <section v-else class="card">
        <div class="row"><b>{{ current >= 0 ? t('cx.partN', { n: current + 1, total: state.partsState.length }) : t('cx.allDone') }}</b><span v-if="timeLeft" class="timer">⏱ {{ timeLeft }}</span></div>
        <ol class="parts">
          <li v-for="(p, i) in state.partsState" :key="p.quizId" :class="p.status">
            {{ partTitle(p.quizId)?.title }}
            <span :class="['badge', p.status]">{{ t(`cx.part.${p.status}`) }}<template v-if="p.score != null && state.showPartsResult"> · {{ p.score }}%</template></span>
            <button v-if="(p.status === 'pending' || p.status === 'in_progress') && (!intro.sequential || i === current)" class="chip" :data-testid="`cx-part-${i}`" @click="open(p.quizId)">{{ p.status === 'in_progress' ? t('cx.continue') : t('cx.open') }}</button>
          </li>
        </ol>
      </section>
    </template>
  </div>
</template>
<style scoped>
.back { color: var(--color-ink-muted); text-decoration: none; font-weight: 700; }
h1 { margin: var(--space-2) 0; font-weight: 900; }
.card { background: var(--color-bg-soft); border-radius: var(--radius-l); padding: var(--space-3); display: grid; gap: var(--space-2); }
.parts { margin: 0; padding-left: var(--space-4); display: grid; gap: var(--space-1); }
.parts.small { font-size: var(--font-size-body-s); }
.parts li { display: flex; gap: var(--space-2); align-items: center; flex-wrap: wrap; }
.row { display: flex; justify-content: space-between; align-items: center; }
.timer { font-variant-numeric: tabular-nums; font-weight: 800; color: var(--color-coral-deep); }
.result { padding: var(--space-3); border-radius: var(--radius-m); display: grid; gap: var(--space-1); }
.result.ok { background: var(--color-teal); color: var(--color-teal-deep); }
.result.bad { background: var(--color-coral); color: var(--color-coral-deep); }
.sub { color: var(--color-ink-muted); font-size: var(--font-size-body-s); margin: 0; }
.badge { font-size: var(--font-size-body-s); font-weight: 700; border-radius: var(--radius-pill); padding: 2px var(--space-2); background: var(--color-bg); color: var(--color-ink-muted); }
.badge.passed { background: var(--color-teal); color: var(--color-teal-deep); }
.badge.failed { background: var(--color-coral); color: var(--color-coral-deep); }
.badge.in_progress { background: var(--color-sun); color: var(--color-sun-ink); }
.chip, .primary { font: inherit; font-weight: 700; border-radius: var(--radius-pill); padding: var(--space-1) var(--space-3); cursor: pointer; }
.chip { border: 1px solid var(--color-bg-line); background: transparent; color: var(--color-ink); }
.primary { border: none; background: var(--color-sun); color: var(--color-ink); font-weight: 800; padding: var(--space-2) var(--space-4); justify-self: start; }
.primary:disabled { opacity: 0.5; }
.error { background: var(--color-coral); color: var(--color-coral-deep); padding: var(--space-3); border-radius: var(--radius-m); }
</style>
