<script setup lang="ts">
import type { ContentBlock } from '../../../../shared/schemas/content'

definePageMeta({ layout: 'admin', middleware: 'admin-scope', requiredScope: 'course.view' })

const { t } = useI18n()
const { api } = useApi()
const { hasScope } = useAuth()
const route = useRoute()
const quizId = route.params.id as string

interface Quiz {
  id: string
  title: string
  kind: string
  status: string
  selectionMode: string
  questionCount: number
  totalPoints: string
}
interface Item { id: string, questionId: string, sort: number, kind: string, stem: ContentBlock[], points: string, isCritical: boolean, difficulty: number }
interface Bank { id: string, name: string, count: number }
interface Question { id: string, kind: string, stem: ContentBlock[], points: string, isCritical: boolean, difficulty: number, bankId: string }

const canEdit = computed(() => hasScope('question.manage'))
const tab = ref<'questions' | 'settings'>('questions')
const quiz = ref<Quiz | null>(null)
const items = ref<Item[]>([])
const banks = ref<Bank[]>([])
const bankId = ref('')
const pool = ref<Question[]>([])
const error = ref('')
const notice = ref('')

// Быстрая форма нового вопроса (single / multiple / number / text_short / text_long)
const nq = reactive({
  kind: 'single', text: '', options: ['', '', ''], correct: [] as number[],
  number: 0, tolerance: 0, accepted: '', criteria: '', points: 1, isCritical: false, difficulty: 3,
})

async function load() {
  try {
    const e = await api<{ quiz: Quiz, items: Item[] }>(`/quizzes/${quizId}`)
    quiz.value = e.quiz
    items.value = e.items
    if (canEdit.value) {
      banks.value = await api<Bank[]>('/question-banks')
      if (!bankId.value && banks.value[0]) bankId.value = banks.value[0].id
    }
  }
  catch (err) {
    error.value = apiErrorOf(err).message
  }
}
onMounted(load)

watch(bankId, async (id) => {
  if (!id) return
  pool.value = await api<Question[]>('/questions', { query: { bankId: id } })
})

function stemText(stem: ContentBlock[]): string {
  const b = stem.find(x => x.type === 'text') as { html: string } | undefined
  return (b?.html ?? '').replace(/<[^>]+>/g, '').slice(0, 120)
}

async function saveItems(next: { questionId: string, sort: number }[]) {
  try {
    await api(`/quizzes/${quizId}/questions`, { method: 'PUT', body: { items: next } })
    await load()
  }
  catch (err) {
    error.value = apiErrorOf(err).message
  }
}
const addFromPool = (q: Question) => saveItems([...items.value.map(i => ({ questionId: i.questionId, sort: i.sort })), { questionId: q.id, sort: items.value.length }])
const removeItem = (id: string) => saveItems(items.value.filter(i => i.questionId !== id).map((i, idx) => ({ questionId: i.questionId, sort: idx })))

async function createBank() {
  const name = prompt(t('quizAdmin.bankName'))
  if (!name || name.length < 3) return
  const b = await api<Bank>('/question-banks', { method: 'POST', body: { name } })
  banks.value.push(b)
  bankId.value = b.id
}

async function createQuestion() {
  error.value = ''
  const ids = ['a', 'b', 'c', 'd', 'e', 'f']
  const stem = [{ id: 'b1', type: 'text', html: `<p>${nq.text}</p>` }]
  let options: unknown
  let answer: unknown
  switch (nq.kind) {
    case 'single':
    case 'multiple': {
      const opts = nq.options.filter(o => o.trim()).map((text, i) => ({ id: ids[i], text }))
      options = opts
      answer = nq.kind === 'single'
        ? { correctId: ids[nq.correct[0] ?? 0] }
        : { correctIds: nq.correct.map(i => ids[i]) }
      break
    }
    case 'number': answer = { value: nq.number, tolerance: nq.tolerance }; break
    case 'text_short': answer = { accepted: nq.accepted.split('\n').map(s => s.trim()).filter(Boolean) }; break
    case 'text_long': answer = { criteria: nq.criteria.split('\n').map(s => s.trim()).filter(Boolean) }; break
  }
  try {
    const q = await api<Question>('/questions', {
      method: 'POST',
      body: { bankId: bankId.value, kind: nq.kind, stem, options, answer, points: nq.points, isCritical: nq.isCritical, difficulty: nq.difficulty },
    })
    nq.text = ''
    nq.options = ['', '', '']
    nq.correct = []
    await addFromPool(q)
    pool.value = await api<Question[]>('/questions', { query: { bankId: bankId.value } })
  }
  catch (err) {
    error.value = apiErrorOf(err).message
  }
}

async function publish() {
  await api(`/quizzes/${quizId}`, { method: 'PATCH', body: { status: 'published' } })
  await load()
}
</script>

<template>
  <div v-if="quiz">
    <NuxtLink to="/admin/quizzes" class="back">← {{ t('admin.nav.quizzes') }}</NuxtLink>
    <header class="head">
      <h1>{{ quiz.title }}</h1>
      <span :class="['badge', quiz.status]">{{ t(`course.status.${quiz.status}`) }}</span>
      <span class="sub">{{ t('quizAdmin.count', { n: quiz.questionCount }) }} · {{ quiz.totalPoints }} {{ t('quizAdmin.pts') }}</span>
      <button v-if="canEdit && quiz.status === 'draft' && quiz.questionCount > 0" class="primary head-btn" @click="publish">{{ t('course.publish') }}</button>
    </header>

    <div class="tabs">
      <button :class="['tab', { on: tab === 'questions' }]" @click="tab = 'questions'">{{ t('quizAdmin.tabQuestions') }}</button>
      <button :class="['tab', { on: tab === 'settings' }]" @click="tab = 'settings'">{{ t('quizAdmin.tabSettings') }}</button>
    </div>

    <p v-if="error" class="error">{{ error }}</p>
    <p v-if="notice" class="notice">{{ notice }}</p>

    <div v-if="tab === 'questions'" class="split">
      <section class="pane">
        <h2>{{ t('quizAdmin.composition') }}</h2>
        <ol class="items">
          <li v-for="it in items" :key="it.id">
            <span class="kind">{{ it.kind }}</span>
            <span class="grow">{{ stemText(it.stem) }}</span>
            <span v-if="it.isCritical" class="crit">!</span>
            <span class="sub">{{ it.points }}</span>
            <button v-if="canEdit" class="mini" @click="removeItem(it.questionId)">✕</button>
          </li>
          <li v-if="items.length === 0" class="sub">{{ t('quizAdmin.noQuestions') }}</li>
        </ol>
      </section>

      <section v-if="canEdit" class="pane">
        <h2>{{ t('quizAdmin.bank') }}</h2>
        <div class="row">
          <select v-model="bankId">
            <option v-for="b in banks" :key="b.id" :value="b.id">{{ b.name }} ({{ b.count }})</option>
          </select>
          <button class="mini" @click="createBank">+</button>
        </div>
        <ul class="pool">
          <li v-for="q in pool.filter(p => !items.some(i => i.questionId === p.id))" :key="q.id">
            <span class="kind">{{ q.kind }}</span>
            <span class="grow">{{ stemText(q.stem) }}</span>
            <button class="mini add" @click="addFromPool(q)">+</button>
          </li>
        </ul>

        <h2>{{ t('quizAdmin.newQuestion') }}</h2>
        <div class="form">
          <select v-model="nq.kind">
            <option value="single">single</option>
            <option value="multiple">multiple</option>
            <option value="number">number</option>
            <option value="text_short">text_short</option>
            <option value="text_long">text_long</option>
          </select>
          <textarea v-model="nq.text" rows="2" :placeholder="t('quizAdmin.stem')" />
          <template v-if="nq.kind === 'single' || nq.kind === 'multiple'">
            <div v-for="(_, i) in nq.options" :key="i" class="row">
              <input
                :type="nq.kind === 'single' ? 'radio' : 'checkbox'"
                :checked="nq.correct.includes(i)"
                @change="nq.correct = nq.kind === 'single' ? [i] : (nq.correct.includes(i) ? nq.correct.filter(x => x !== i) : [...nq.correct, i])"
              >
              <input v-model="nq.options[i]" :placeholder="`${t('quizAdmin.option')} ${i + 1}`">
            </div>
            <button class="mini" @click="nq.options.push('')">+ {{ t('quizAdmin.option') }}</button>
          </template>
          <div v-else-if="nq.kind === 'number'" class="row">
            <input v-model.number="nq.number" type="number" step="any" :placeholder="t('quizAdmin.value')">
            <input v-model.number="nq.tolerance" type="number" step="any" :placeholder="t('quizAdmin.tolerance')">
          </div>
          <textarea v-else-if="nq.kind === 'text_short'" v-model="nq.accepted" rows="2" :placeholder="t('quizAdmin.accepted')" />
          <textarea v-else v-model="nq.criteria" rows="2" :placeholder="t('quizAdmin.criteria')" />
          <div class="row">
            <label class="inline">{{ t('quizAdmin.points') }} <input v-model.number="nq.points" type="number" min="0.1" step="0.1" class="num"></label>
            <label class="inline"><input v-model="nq.isCritical" type="checkbox"> {{ t('quizAdmin.critical') }}</label>
          </div>
          <button class="primary" :disabled="!bankId || nq.text.trim().length < 3" @click="createQuestion">{{ t('quizAdmin.addQuestion') }}</button>
        </div>
      </section>
    </div>

    <div v-else class="pane settings">
      <p class="hint">{{ t('quizAdmin.rulesInTask') }}</p>
      <NuxtLink to="/admin/assignments/new" class="link">{{ t('quizAdmin.goAssign') }}</NuxtLink>
    </div>
  </div>
  <p v-else-if="error" class="error">{{ error }}</p>
</template>

<style scoped>
.back { color: var(--color-ink-muted); text-decoration: none; font-size: var(--font-size-body-s); }
.head { display: flex; align-items: center; gap: var(--space-3); flex-wrap: wrap; margin: var(--space-2) 0 var(--space-4); }
h1 { margin: 0; font-weight: 900; }
h2 { margin: 0 0 var(--space-2); font-size: var(--font-size-body-s); color: var(--color-ink-faint); text-transform: uppercase; letter-spacing: 0.04em; }
.head-btn { margin-left: auto; }
.tabs { display: flex; gap: var(--space-2); margin-bottom: var(--space-4); }
.tab { font: inherit; font-weight: 700; border: 1px solid var(--color-bg-line); background: transparent; color: var(--color-ink-muted); border-radius: var(--radius-pill); padding: var(--space-1) var(--space-4); cursor: pointer; }
.tab.on { background: var(--color-ink); border-color: var(--color-ink); color: var(--color-bg-soft); }
.split { display: grid; grid-template-columns: 1fr 1fr; gap: var(--space-4); }
@media (max-width: 900px) { .split { grid-template-columns: 1fr; } }
.pane { background: var(--color-bg-soft); border-radius: var(--radius-m); padding: var(--space-4); display: grid; gap: var(--space-3); align-content: start; }
.items, .pool { list-style: none; margin: 0; padding: 0; display: grid; gap: var(--space-1); }
.items li, .pool li { display: flex; align-items: center; gap: var(--space-2); background: var(--color-bg); border-radius: var(--radius-s); padding: var(--space-2) var(--space-3); font-size: var(--font-size-body-s); }
.pool { max-height: 240px; overflow: auto; }
.grow { flex: 1; }
.kind { color: var(--color-ink-faint); font-family: monospace; }
.crit { color: var(--color-coral-ink); font-weight: 900; }
.mini { font: inherit; border: 1px solid var(--color-bg-line); background: transparent; border-radius: var(--radius-pill); padding: 0 var(--space-2); cursor: pointer; color: var(--color-ink-muted); }
.mini.add { background: var(--color-sun); border-color: var(--color-sun); color: var(--color-ink); }
.row { display: flex; gap: var(--space-2); align-items: center; }
.inline { display: flex; gap: var(--space-2); align-items: center; font-size: var(--font-size-body-s); }
.form { display: grid; gap: var(--space-2); }
input, select, textarea { font: inherit; border: 1px solid var(--color-bg-line); border-radius: var(--radius-s); padding: var(--space-1) var(--space-2); background: var(--color-bg); color: var(--color-ink); }
input[type="radio"], input[type="checkbox"] { width: auto; }
.num { width: 64px; }
.settings label { display: flex; justify-content: space-between; align-items: center; gap: var(--space-3); }
.settings input:not([type="checkbox"]), .settings select { width: 140px; }
.primary { font: inherit; font-weight: 800; border: none; background: var(--color-sun); color: var(--color-ink); border-radius: var(--radius-pill); padding: var(--space-2) var(--space-4); cursor: pointer; justify-self: start; }
.primary:disabled { opacity: 0.5; }
.badge { font-size: var(--font-size-body-s); font-weight: 700; border-radius: var(--radius-pill); padding: 2px var(--space-3); background: var(--color-bg-line-soft); }
.badge.published { background: var(--color-teal); color: var(--color-teal-deep); }
.badge.draft { background: var(--color-sun); color: var(--color-sun-ink); }
.sub { font-size: var(--font-size-body-s); color: var(--color-ink-faint); }
.error { color: var(--color-coral-ink); }
.notice { color: var(--color-teal-ink); }
</style>
