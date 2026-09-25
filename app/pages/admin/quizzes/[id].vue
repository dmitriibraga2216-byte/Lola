<script setup lang="ts">
import type { ContentBlock } from '../../../../shared/schemas/content'
import { QUIZ_KINDS } from '#shared/enums'

/**
 * Редактор теста (docs/12 §14.1, §14.3, Г-12.2): вкладки «Питання» / «Опис та налаштування»,
 * группы вопросов, три способа добавить — «Питання» (новое), «Скопіювати з іншого тесту»,
 * «Додати з банку» (ссылка); «Перерахувати» результаты по текущему ключу (docs/22 §13.7).
 * Правил прохождения здесь нет — они в назначении.
 */
definePageMeta({ layout: 'admin', middleware: 'admin-scope', requiredScope: 'course.view' })

const { t } = useI18n()
const { api } = useApi()
const { hasScope } = useAuth()
const route = useRoute()
const quizId = route.params.id as string

interface Quiz { id: string, title: string, kind: string, status: string, selectionMode: string, questionCount: number, totalPoints: string, tags: string[] }
interface Item { id: string, questionId: string, sort: number, kind: string, stem: ContentBlock[], points: string, isCritical: boolean, difficulty: number, tags: string[], questionGroupId: string | null }
interface Group { id: string, title: string, sortOrder: number }
interface Bank { id: string, name: string, count: number }
interface Question { id: string, kind: string, stem: ContentBlock[], points: string, tags: string[] }
interface QuizRow { id: string, title: string, questionCount: number }

const canEdit = computed(() => hasScope('question.manage'))
const tab = ref<'questions' | 'settings'>('questions')
const quiz = ref<Quiz | null>(null)
const items = ref<Item[]>([])
const groups = ref<Group[]>([])
const error = ref('')
const notice = ref('')
const busy = ref(false)

// Панель добавления: bank (ссылка) | other (копия)
const addMode = ref<'none' | 'bank' | 'other'>('none')
const banks = ref<Bank[]>([])
const bankId = ref('')
const otherQuizzes = ref<QuizRow[]>([])
const otherQuizId = ref('')
const pool = ref<Question[]>([])
const picked = ref<string[]>([])
const search = ref('')
const targetGroup = ref('')
const newGroup = ref('')

async function load() {
  try {
    const e = await api<{ quiz: Quiz, items: Item[], groups: Group[] }>(`/quizzes/${quizId}`)
    quiz.value = e.quiz
    items.value = e.items
    groups.value = e.groups
  }
  catch (err) {
    error.value = apiErrorOf(err).message
  }
}
onMounted(load)

watch(addMode, async (m) => {
  picked.value = []
  pool.value = []
  if (m === 'bank') {
    banks.value = await api<Bank[]>('/question-banks')
    if (!bankId.value && banks.value[0]) bankId.value = banks.value[0].id
    await loadPool()
  }
  if (m === 'other') {
    otherQuizzes.value = (await api<QuizRow[]>('/quizzes')).filter(q => q.id !== quizId)
    if (!otherQuizId.value && otherQuizzes.value[0]) otherQuizId.value = otherQuizzes.value[0].id
    await loadPool()
  }
})
watch([bankId, otherQuizId, search], loadPool)

async function loadPool() {
  if (addMode.value === 'none') return
  const query = addMode.value === 'bank' ? { bankId: bankId.value, q: search.value || undefined } : { quizId: otherQuizId.value, q: search.value || undefined }
  if (!(query.bankId || query.quizId)) return
  pool.value = await api<Question[]>('/questions', { query })
}

function stemText(stem: ContentBlock[]): string {
  const b = stem.find(x => x.type === 'text') as { html: string } | undefined
  return (b?.html ?? '').replace(/<[^>]+>/g, '').slice(0, 120)
}
const groupTitle = (id: string | null) => groups.value.find(g => g.id === id)?.title ?? ''

async function saveItems(next: { questionId: string, sort: number }[]) {
  try {
    await api(`/quizzes/${quizId}/questions`, { method: 'PUT', body: { items: next } })
    await load()
  }
  catch (err) {
    error.value = apiErrorOf(err).message
  }
}
const removeItem = (id: string) => saveItems(items.value.filter(i => i.questionId !== id).map((i, idx) => ({ questionId: i.questionId, sort: idx })))
function moveItem(i: number, dir: -1 | 1) {
  const list = [...items.value]
  const j = i + dir
  if (j < 0 || j >= list.length) return
  ;[list[i], list[j]] = [list[j]!, list[i]!]
  saveItems(list.map((it, idx) => ({ questionId: it.questionId, sort: idx })))
}

async function importPicked() {
  if (!picked.value.length) return
  busy.value = true
  error.value = ''
  try {
    const body = addMode.value === 'other'
      ? { mode: 'copy', fromQuizId: otherQuizId.value, questionIds: picked.value, questionGroupId: targetGroup.value || null }
      : { mode: 'link', questionIds: picked.value, questionGroupId: targetGroup.value || undefined }
    const r = await api<{ added: number }>(`/tests/${quizId}/questions/import`, { method: 'POST', body })
    notice.value = t('quizAdmin.added', { n: r.added })
    picked.value = []
    await load()
    await loadPool()
  }
  catch (err) {
    error.value = apiErrorOf(err).message
  }
  finally {
    busy.value = false
  }
}

async function addGroup() {
  const title = newGroup.value.trim()
  if (!title) return
  await api(`/tests/${quizId}/question-groups`, { method: 'POST', body: { title, sortOrder: groups.value.length } })
  newGroup.value = ''
  await load()
}
async function renameGroup(g: Group) {
  const title = prompt(t('quizAdmin.groupName'), g.title)
  if (!title || title === g.title) return
  await api(`/question-groups/${g.id}`, { method: 'PATCH', body: { title } })
  await load()
}
async function removeGroup(g: Group) {
  await api(`/question-groups/${g.id}`, { method: 'DELETE' })
  await load()
}

async function publish() {
  await api(`/quizzes/${quizId}`, { method: 'PATCH', body: { status: 'published' } })
  await load()
}

/** Вид тесту (`QUIZ_KINDS`): змінити на «Співбесіда» і назад можна, доки немає жодної спроби. */
const kind = ref<string>('quiz')
watch(quiz, q => { if (q) kind.value = q.kind }, { immediate: true })
async function saveKind() {
  busy.value = true
  error.value = ''
  try {
    await api(`/quizzes/${quizId}`, { method: 'PATCH', body: { kind: kind.value } })
    notice.value = t('quizAdmin.kindSaved')
    await load()
  }
  catch (err) {
    error.value = apiErrorOf(err).message
    kind.value = quiz.value?.kind ?? 'quiz'
  }
  finally { busy.value = false }
}

async function recalculate() {
  const comment = prompt(t('quizAdmin.recalcReason')) ?? ''
  busy.value = true
  try {
    const r = await api<{ total: number, changed: number }>(`/tests/${quizId}/recalculate`, { method: 'POST', body: { comment: comment || undefined } })
    notice.value = t('quizAdmin.recalcDone', { total: r.total, changed: r.changed })
  }
  catch (err) {
    error.value = apiErrorOf(err).message
  }
  finally {
    busy.value = false
  }
}
</script>

<template>
  <div v-if="quiz">
    <PageHeader
      :title="quiz.title"
      :crumbs="[{ label: t('admin.section.content') }, { label: t('admin.nav.quizzes'), to: '/admin/quizzes' }]"
      :subtitle="`${t('quizAdmin.count', { n: quiz.questionCount })} · ${quiz.totalPoints} ${t('quizAdmin.pts')}`"
    >
      <template #actions>
        <span :class="['badge', quiz.status]">{{ t(`course.status.${quiz.status}`) }}</span>
        <button v-if="canEdit" class="btn ghost" :disabled="busy" @click="recalculate">{{ t('quizAdmin.recalc') }}</button>
        <button v-if="canEdit && quiz.status === 'draft' && quiz.questionCount > 0" class="btn primary" @click="publish">{{ t('course.publish') }}</button>
      </template>
    </PageHeader>

    <div class="chips tabs" role="tablist">
      <button role="tab" :aria-selected="tab === 'questions'" :class="['chip', { on: tab === 'questions' }]" @click="tab = 'questions'">{{ t('quizAdmin.tabQuestions') }}</button>
      <button role="tab" :aria-selected="tab === 'settings'" :class="['chip', { on: tab === 'settings' }]" @click="tab = 'settings'">{{ t('quizAdmin.tabSettings') }}</button>
    </div>

    <p v-if="error" class="error-text">{{ error }}</p>
    <p v-if="notice" class="note teal">{{ notice }}</p>

    <div v-if="tab === 'questions'" class="split">
      <section class="card">
        <div class="head-row">
          <h2 class="panel-title">{{ t('quizAdmin.composition') }}</h2>
          <div v-if="canEdit" class="chips">
            <NuxtLink :to="`/admin/questions/new?quizId=${quizId}`" class="btn primary small">{{ t('quizAdmin.addNew') }}</NuxtLink>
            <button :class="['chip', { on: addMode === 'other' }]" @click="addMode = addMode === 'other' ? 'none' : 'other'">{{ t('quizAdmin.copyFromOther') }}</button>
            <button :class="['chip', { on: addMode === 'bank' }]" @click="addMode = addMode === 'bank' ? 'none' : 'bank'">{{ t('quizAdmin.addFromBank') }}</button>
          </div>
        </div>
        <ol class="items">
          <li v-for="(it, i) in items" :key="it.id">
            <span class="n">{{ i + 1 }}</span>
            <span class="grow">
              <NuxtLink v-if="canEdit" :to="`/admin/questions/${it.questionId}?quizId=${quizId}`" class="link">{{ stemText(it.stem) }}</NuxtLink>
              <span v-else>{{ stemText(it.stem) }}</span>
              <span class="sub">{{ t(`questionEditor.kinds.${it.kind}`) }}<template v-if="it.questionGroupId"> · {{ groupTitle(it.questionGroupId) }}</template><template v-if="it.tags.length"> · {{ it.tags.join(', ') }}</template></span>
            </span>
            <span v-if="it.isCritical" class="badge coral">!</span>
            <span class="badge muted">{{ it.points }}</span>
            <template v-if="canEdit">
              <button class="btn ghost small" :aria-label="t('questionEditor.up')" :disabled="i === 0" @click="moveItem(i, -1)">↑</button>
              <button class="btn ghost small" :aria-label="t('questionEditor.down')" :disabled="i === items.length - 1" @click="moveItem(i, 1)">↓</button>
              <button class="btn ghost small" :aria-label="t('questionEditor.remove')" @click="removeItem(it.questionId)">✕</button>
            </template>
          </li>
          <li v-if="items.length === 0" class="muted">{{ t('quizAdmin.noQuestions') }}</li>
        </ol>
      </section>

      <div class="stack">
        <section v-if="canEdit && addMode !== 'none'" class="card">
          <h2 class="panel-title">{{ addMode === 'bank' ? t('quizAdmin.addFromBank') : t('quizAdmin.copyFromOther') }}</h2>
          <p class="help">{{ addMode === 'bank' ? t('quizAdmin.linkHint') : t('quizAdmin.copyHint') }}</p>
          <div class="row">
            <select v-if="addMode === 'bank'" v-model="bankId" class="field" :aria-label="t('quizAdmin.bank')">
              <option v-for="b in banks" :key="b.id" :value="b.id">{{ b.name }} ({{ b.count }})</option>
            </select>
            <select v-else v-model="otherQuizId" class="field" :aria-label="t('quizAdmin.otherQuiz')">
              <option v-for="q in otherQuizzes" :key="q.id" :value="q.id">{{ q.title }} ({{ q.questionCount }})</option>
            </select>
            <input v-model="search" class="field" :placeholder="t('quizAdmin.search')" :aria-label="t('quizAdmin.search')">
          </div>
          <ul class="pool">
            <li v-for="q in pool.filter(p => addMode === 'other' || !items.some(i => i.questionId === p.id))" :key="q.id">
              <label class="pick">
                <input v-model="picked" type="checkbox" :value="q.id">
                <span class="grow">{{ stemText(q.stem) }} <span class="sub">{{ t(`questionEditor.kinds.${q.kind}`) }} · {{ q.points }}</span></span>
              </label>
            </li>
            <li v-if="pool.length === 0" class="muted">{{ t('quizAdmin.poolEmpty') }}</li>
          </ul>
          <div class="row">
            <select v-model="targetGroup" class="field" :aria-label="t('questionEditor.group')">
              <option value="">{{ t('quizAdmin.noGroup') }}</option>
              <option v-for="g in groups" :key="g.id" :value="g.id">{{ g.title }}</option>
            </select>
            <button class="btn primary" :disabled="busy || picked.length === 0" @click="importPicked">{{ t('quizAdmin.addPicked', { n: picked.length }) }}</button>
          </div>
        </section>

        <section class="card">
          <h2 class="panel-title">{{ t('quizAdmin.groups') }}</h2>
          <p class="help">{{ t('questionEditor.groupHint') }}</p>
          <ul class="groups">
            <li v-for="g in groups" :key="g.id">
              <span class="grow">{{ g.title }} <span class="sub">{{ t('quizAdmin.countShort', { n: items.filter(i => i.questionGroupId === g.id).length }) }}</span></span>
              <template v-if="canEdit">
                <button class="btn ghost small" @click="renameGroup(g)">{{ t('common.edit') }}</button>
                <button class="btn ghost small" :aria-label="t('questionEditor.remove')" @click="removeGroup(g)">✕</button>
              </template>
            </li>
            <li v-if="groups.length === 0" class="muted">{{ t('quizAdmin.noGroups') }}</li>
          </ul>
          <form v-if="canEdit" class="row" @submit.prevent="addGroup">
            <input v-model="newGroup" class="field" :placeholder="t('quizAdmin.groupName')" :aria-label="t('quizAdmin.groupName')">
            <button class="btn ghost" type="submit" :disabled="!newGroup.trim()">+ {{ t('quizAdmin.addGroup') }}</button>
          </form>
        </section>
      </div>
    </div>

    <div v-else class="card stack-s">
      <!-- Вид тесту (docs/v2/44 В-12): «Співбесіда» проходять через екран згоди, сценарій — у «Сценарії співбесід» -->
      <label class="label" for="quiz-kind">{{ t('quizAdmin.kind') }}</label>
      <select id="quiz-kind" v-model="kind" class="field" :disabled="!canEdit || busy" @change="saveKind">
        <option v-for="k in QUIZ_KINDS" :key="k" :value="k">{{ t(`quizAdmin.kinds.${k}`) }}</option>
      </select>
      <p v-if="kind === 'interview'" class="help">{{ t('quizAdmin.kindInterviewHint') }}</p>
      <p class="help">{{ t('quizAdmin.rulesInTask') }}</p>
      <NuxtLink to="/admin/assignments/new?type=test" class="link">{{ t('quizAdmin.goAssign') }}</NuxtLink>
    </div>
  </div>
  <p v-else-if="error" class="error-text">{{ error }}</p>
</template>

<style scoped>
.tabs { margin-bottom: var(--space-4); }
.stack-s { display: grid; gap: var(--space-2); max-width: 32rem; }
.split { display: grid; grid-template-columns: minmax(0, 3fr) minmax(0, 2fr); gap: var(--space-4); align-items: start; }
@media (max-width: 900px) { .split { grid-template-columns: 1fr; } }
.stack { display: grid; gap: var(--space-4); }
.head-row { display: flex; align-items: center; justify-content: space-between; gap: var(--space-3); flex-wrap: wrap; margin-bottom: var(--space-3); }
.items, .pool, .groups { list-style: none; margin: 0; padding: 0; display: grid; gap: var(--space-1); }
.items li, .pool li, .groups li { display: flex; align-items: center; gap: var(--space-2); background: var(--color-bg); border-radius: var(--radius-s); padding: var(--space-2) var(--space-3); font-size: var(--font-size-body-s); }
.pool { max-height: 320px; overflow: auto; margin: var(--space-3) 0; }
.pick { display: flex; gap: var(--space-2); align-items: center; width: 100%; cursor: pointer; }
.grow { flex: 1; min-width: 0; }
.sub { display: block; color: var(--color-ink-faint); }
.n { width: 24px; height: 24px; flex: none; border-radius: var(--radius-pill); background: var(--color-ink); color: var(--color-bg); display: grid; place-items: center; font-weight: 800; }
.row { display: flex; gap: var(--space-2); flex-wrap: wrap; margin-top: var(--space-2); }
.row .field { flex: 1; min-width: 160px; }
</style>
