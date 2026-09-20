<script setup lang="ts">
/**
 * Опитування за мокапом Poll: одне питання на екран — «ПИТАННЯ 3 З 6 · АНОНІМНО», варіанти картками,
 * «або Свій варіант відповіді», «Далі». Наступне питання віддає сервер (режим «з умовами» — за правилами).
 */
definePageMeta({ layout: 'learner' })
const { t } = useI18n()
const { api } = useApi()

interface Opt { id: string, text: string }
interface Q { id: string, type: 'single' | 'multi' | 'free' | 'scale', text: string, options?: Opt[], allowOwnOption?: boolean, allowFiles?: boolean, required?: boolean, scale: { name: string, options: { value: number, label: string }[] } | null }
interface S { id: string, title: string, description: string | null, isAnonymous: boolean, closesAt: string | null, questions: number, inProgress: boolean }
interface Step { question: Q | null, index: number, total: number, isAnonymous: boolean, mode: string, title: string }
interface Results { total: number, hidden: boolean, threshold?: number, questions: { id: string, text: string, type: string, answered: number, avg?: number | null, distribution?: Record<string, number> }[] }
const items = ref<S[]>([])
const active = ref<S | null>(null)
const step = ref<Step | null>(null)
const results = ref<Results | null>(null)
const pick = ref<string | null>(null)
const picks = ref<string[]>([])
const own = ref('')
const text = ref('')
const value = ref<number | null>(null)
const error = ref('')
const notice = ref('')
const busy = ref(false)

async function load() {
  try { items.value = await api<S[]>('/learning/surveys') }
  catch (err) { error.value = apiErrorOf(err).message }
}
onMounted(load)

function resetAnswer() { pick.value = null; picks.value = []; own.value = ''; text.value = ''; value.value = null }
async function start(s: S) {
  error.value = ''; notice.value = ''; results.value = null
  try { step.value = await api<Step>(`/learning/surveys/${s.id}/start`, { method: 'POST', body: {} }); active.value = s; resetAnswer() }
  catch (err) { error.value = apiErrorOf(err).message }
}
const q = computed(() => step.value?.question ?? null)
function answerBody() {
  if (!q.value) return null
  switch (q.value.type) {
    case 'single': return own.value.trim() && !pick.value ? { own: own.value.trim() } : pick.value ? { optionId: pick.value } : null
    case 'multi': return picks.value.length || own.value.trim() ? { optionIds: picks.value, ...(own.value.trim() ? { own: own.value.trim() } : {}) } : null
    case 'free': return text.value.trim() ? { text: text.value.trim() } : null
    case 'scale': return value.value != null ? { value: value.value } : null
  }
}
const canNext = computed(() => !!q.value && (q.value.required === false || answerBody() != null))
async function next() {
  if (!active.value || !q.value) return
  error.value = ''; busy.value = true
  try {
    const r = await api<{ done: false, question: Q, index: number, total: number } | { done: true, results: Results | null }>(`/learning/surveys/${active.value.id}/answer`, { method: 'POST', body: { questionId: q.value.id, answer: answerBody() } })
    if (r.done) { notice.value = t('survey.thanks'); results.value = r.results; step.value = null; active.value = null; await load() }
    else { step.value = { ...step.value!, question: r.question, index: r.index, total: r.total }; resetAnswer() }
  }
  catch (err) { error.value = apiErrorOf(err).message }
  finally { busy.value = false }
}
function togglePick(id: string) { const i = picks.value.indexOf(id); if (i >= 0) picks.value.splice(i, 1); else picks.value.push(id) }
</script>

<template>
  <div>
    <template v-if="!active || !step">
      <h1>{{ t('survey.title') }}</h1>
      <p v-if="error" class="error">{{ error }}</p>
      <p v-if="notice" class="notice">{{ notice }}</p>
      <section v-if="results" class="results">
        <h2>{{ t('survey.resultsTitle') }}</h2>
        <p v-if="results.hidden" class="sub">{{ t('survey.hiddenThreshold', { n: results.threshold }) }}</p>
        <div v-for="rq in results.questions" :key="rq.id" class="rq">
          <b>{{ rq.text }}</b>
          <span v-if="rq.avg != null" class="sub">{{ t('survey.avg') }}: {{ rq.avg }}</span>
          <span v-if="rq.distribution" class="sub">{{ Object.entries(rq.distribution).map(([k, n]) => `${k}: ${n}`).join(' · ') }}</span>
        </div>
      </section>
      <p v-if="items.length === 0" class="empty">{{ t('survey.empty') }}</p>
      <div class="list">
        <button v-for="s in items" :key="s.id" class="card" :data-testid="`survey-${s.id}`" @click="start(s)">
          <span class="card-title">{{ s.title }}</span>
          <span class="sub">{{ s.questions }} {{ t('survey.questions') }}{{ s.isAnonymous ? ` · ${t('survey.anonymous')}` : '' }}{{ s.inProgress ? ` · ${t('survey.continue')}` : '' }}</span>
        </button>
      </div>
    </template>

    <div v-else class="poll">
      <div class="head">
        <button type="button" class="back" :aria-label="t('common.back')" @click="active = null; step = null">←</button>
        <h1 class="ptitle">{{ step.title }}</h1>
      </div>
      <div class="bar" role="progressbar" :aria-valuenow="step.index" :aria-valuemax="step.total"><i :style="{ width: `${(step.index / Math.max(step.total, 1)) * 100}%` }" /></div>
      <p v-if="error" class="error">{{ error }}</p>
      <template v-if="q">
        <div class="kicker">{{ t('survey.questionOf', { n: step.index, total: step.total }) }}<template v-if="step.isAnonymous"> · {{ t('survey.anonymous') }}</template></div>
        <h2 class="qtext">{{ q.text }}</h2>

        <div v-if="q.type === 'single'" class="options" role="radiogroup">
          <button v-for="o in q.options" :key="o.id" type="button" role="radio" :aria-checked="pick === o.id" :class="['option', { on: pick === o.id }]" @click="pick = o.id; own = ''"><i class="dot" /><span>{{ o.text }}</span></button>
          <div v-if="q.allowOwnOption" class="own"><span class="sub">{{ t('survey.or') }}</span><input v-model="own" class="field own-field" :placeholder="t('survey.ownOption')" @input="pick = null"></div>
        </div>
        <div v-else-if="q.type === 'multi'" class="options">
          <button v-for="o in q.options" :key="o.id" type="button" role="checkbox" :aria-checked="picks.includes(o.id)" :class="['option', { on: picks.includes(o.id) }]" @click="togglePick(o.id)"><i class="dot square" /><span>{{ o.text }}</span></button>
          <div v-if="q.allowOwnOption" class="own"><span class="sub">{{ t('survey.or') }}</span><input v-model="own" class="field own-field" :placeholder="t('survey.ownOption')"></div>
        </div>
        <div v-else-if="q.type === 'scale'" class="scale" role="radiogroup">
          <button v-for="o in (q.scale?.options ?? [1, 2, 3, 4, 5].map(n => ({ value: n, label: String(n) })))" :key="o.value" type="button" role="radio" :aria-checked="value === o.value" :class="['opt', { on: value === o.value }]" :title="o.label" @click="value = o.value">{{ o.label }}</button>
        </div>
        <textarea v-else v-model="text" rows="4" class="field" :placeholder="t('survey.freeHint')" />
      </template>
      <div class="foot">
        <button class="primary" :disabled="busy || !canNext" data-testid="poll-next" @click="next">{{ t('common.next') }}</button>
      </div>
    </div>
  </div>
</template>

<style scoped>
h1 { margin: 0 0 var(--space-4); font-weight: 900; }
h2 { margin: 0; font-weight: 800; }
.list { display: grid; gap: var(--space-2); }
.card { font: inherit; text-align: left; background: var(--color-bg-soft); border: none; border-radius: var(--radius-m); padding: var(--space-3) var(--space-4); cursor: pointer; display: grid; gap: var(--space-1); color: var(--color-ink); }
.card-title { font-weight: 800; }
.results { display: grid; gap: var(--space-2); background: var(--color-bg-soft); border-radius: var(--radius-l); padding: var(--space-3); margin-bottom: var(--space-3); }
.rq { display: grid; gap: 2px; }
.poll { display: flex; flex-direction: column; min-height: 70dvh; }
.head { display: flex; align-items: center; gap: var(--space-3); }
.back { font: inherit; border: none; background: none; font-size: 22px; font-weight: 900; cursor: pointer; padding: 0; color: var(--color-ink); }
.ptitle { margin: var(--space-2) 0; font-size: 20px; letter-spacing: -0.01em; }
.bar { height: 8px; background: var(--color-bg-line-soft); border-radius: var(--radius-pill); overflow: hidden; margin-bottom: var(--space-4); }
.bar i { display: block; height: 100%; background: var(--color-teal); border-radius: var(--radius-pill); transition: width 0.2s; }
.kicker { font-size: 12px; font-weight: 900; letter-spacing: 0.08em; text-transform: uppercase; color: var(--color-ink-muted); margin-bottom: var(--space-2); }
.qtext { font-size: 21px; line-height: 27px; letter-spacing: -0.01em; margin-bottom: var(--space-4); }
.options { display: grid; gap: var(--space-2); }
.option { font: inherit; text-align: left; display: flex; gap: var(--space-3); align-items: center; background: var(--color-bg-soft); border: 2px solid var(--color-bg-line); border-radius: var(--radius-l); padding: var(--space-3) var(--space-4); cursor: pointer; color: var(--color-ink); font-weight: 600; min-height: 48px; }
.option.on { border-color: var(--color-ink); font-weight: 800; }
.dot { width: 22px; height: 22px; border-radius: 50%; border: 2px solid var(--color-bg-line); flex: none; }
.dot.square { border-radius: var(--radius-s); }
.option.on .dot { background: var(--color-ink); border-color: var(--color-ink); }
.own { display: flex; align-items: center; gap: var(--space-2); margin-top: var(--space-1); }
.own-field { border: 2px dashed var(--color-bg-line); border-radius: var(--radius-l); }
.scale { display: flex; gap: var(--space-2); flex-wrap: wrap; }
.opt { font: inherit; font-weight: 800; min-width: 48px; height: 48px; padding: 0 var(--space-3); border: 2px solid var(--color-bg-line); background: var(--color-bg-soft); border-radius: var(--radius-pill); cursor: pointer; color: var(--color-ink); }
.opt.on { background: var(--color-ink); border-color: var(--color-ink); color: var(--color-bg-soft); }
.foot { margin-top: auto; padding-top: var(--space-4); }
.primary { font: inherit; font-weight: 800; border: none; border-radius: var(--radius-pill); padding: var(--space-3) var(--space-5); cursor: pointer; background: var(--color-sun); color: var(--color-ink); width: 100%; min-height: 48px; }
.primary:disabled { opacity: 0.5; }
.sub { font-size: var(--font-size-body-s); color: var(--color-ink-faint); margin: 0; }
.empty { color: var(--color-ink-faint); text-align: center; padding: var(--space-7); }
.error { color: var(--color-coral-ink); }
.notice { color: var(--color-teal-ink); }
</style>
