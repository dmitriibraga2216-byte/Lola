<script setup lang="ts">
/**
 * Реєстр і канбан кандидатів — `/admin/candidates` (docs/v2/28-recruiting-candidates.md §5.1, §5.2).
 *
 * Дошка не вантажить колонку цілком: сервер віддає по 50 карток і курсор, кнопка «Показати ще»
 * добирає наступну сторінку **однієї** колонки, не перебудовуючи дошку (критерій §13 к. 12 —
 * 250 карток у колонці). Рахує теж сервер: скільки днів у статусі, чи маскувати контакти,
 * скільки місць лишилось за тарифом (CLAUDE.md п. 3).
 */
import type { CandidateState } from '#shared/enums'
const { formatDate } = useFormat()

definePageMeta({ layout: 'admin', middleware: 'admin-scope', requiredScope: 'candidate.view' })

const { t } = useI18n()
const { api } = useApi()
const route = useRoute()
const router = useRouter()

interface Card {
  id: string
  fullName: string
  phone: string | null
  email: string | null
  state: CandidateState
  statusId: string | null
  source: string | null
  recruiterName: string | null
  accessUntil: string | null
  daysInStatus: number | null
  scores: Record<string, string | null>
  createdAt: string
}
interface Column {
  statusId: string
  code: string
  nameUk: string
  color: string
  mapsTo: CandidateState
  total: number
  cards: Card[]
  nextCursor: string | null
}
interface Meta { current: number, limit: number | null, limitLeft: number | null }

const view = ref<'board' | 'list'>(route.query.view === 'list' ? 'list' : 'board')
const columns = ref<Column[]>([])
const rows = ref<Card[]>([])
const meta = ref<Meta | null>(null)
const q = ref('')
const error = ref('')
const busy = ref('')

async function load() {
  error.value = ''
  busy.value = 'load'
  try {
    if (view.value === 'board') {
      const res = await api<{ columns: Column[], meta: Meta }>('/candidates/board', { query: { ...(q.value ? { q: q.value } : {}) } })
      columns.value = res.columns
      meta.value = res.meta
    }
    else {
      const res = await api<{ items: Card[], meta: Meta }>('/candidates', { query: { ...(q.value ? { q: q.value } : {}) } })
      rows.value = res.items
      meta.value = res.meta
    }
  }
  catch (err) { error.value = apiErrorOf(err).message }
  finally { busy.value = '' }
}
onMounted(load)

watch(view, (v) => {
  router.replace({ query: { ...route.query, view: v } })
  load()
})

/** «Показати ще» — наступна сторінка однієї колонки за курсором (§5.2). */
async function loadMore(col: Column) {
  if (!col.nextCursor) return
  busy.value = col.statusId
  try {
    const page = await api<{ cards: Card[], nextCursor: string | null, total: number }>('/candidates/board', {
      query: { statusId: col.statusId, cursor: col.nextCursor, ...(q.value ? { q: q.value } : {}) },
    })
    col.cards = [...col.cards, ...page.cards]
    col.nextCursor = page.nextCursor
    col.total = page.total
  }
  catch (err) { error.value = apiErrorOf(err).message }
  finally { busy.value = '' }
}

/** Перетягування картки = зміна колонки (§5.2); рішення про дозволеність ухвалює сервер. */
const dragging = ref<string | null>(null)
async function drop(col: Column) {
  const id = dragging.value
  dragging.value = null
  if (!id) return
  busy.value = col.statusId
  error.value = ''
  try {
    await api(`/candidates/${id}/status`, { method: 'POST', body: { statusId: col.statusId } })
    await load()
  }
  catch (err) { error.value = apiErrorOf(err).message }
  finally { busy.value = '' }
}

const dateOf = (v: string | null) => v ? formatDate(new Date(v), { day: '2-digit', month: '2-digit', year: 'numeric' }) : '—'
</script>

<template>
  <div>
    <PageHeader :title="t('candidates.title')" :subtitle="t('candidates.hint')">
      <span v-if="meta" class="counter">{{ t('candidates.counter', { n: meta.current, m: meta.limit ?? '∞' }) }}</span>
    </PageHeader>

    <p v-if="error" class="error" role="alert">{{ error }}</p>

    <div class="filters">
      <label class="grow">{{ t('common.search') }}
        <input v-model="q" maxlength="200" @keyup.enter="load">
      </label>
      <button class="btn" type="button" :disabled="busy === 'load'" @click="load">{{ t('candidates.apply') }}</button>
      <div class="tabs" role="tablist">
        <button role="tab" :aria-selected="view === 'board'" :class="['tab', { on: view === 'board' }]" @click="view = 'board'">{{ t('candidates.board') }}</button>
        <button role="tab" :aria-selected="view === 'list'" :class="['tab', { on: view === 'list' }]" @click="view = 'list'">{{ t('candidates.list') }}</button>
      </div>
    </div>

    <div v-if="view === 'board'" class="board">
      <section
        v-for="col in columns" :key="col.statusId" class="column"
        @dragover.prevent @drop="drop(col)"
      >
        <header :class="['col-head', `tone-${col.color}`]">
          <strong>{{ col.nameUk }}</strong>
          <span class="sub">{{ col.total }}</span>
        </header>
        <article
          v-for="c in col.cards" :key="c.id" class="kcard" draggable="true"
          @dragstart="dragging = c.id"
        >
          <NuxtLink class="link" :to="`/admin/candidates/${c.id}`">{{ c.fullName }}</NuxtLink>
          <div class="sub">{{ c.recruiterName ?? t('candidates.noRecruiter') }}</div>
          <div class="sub">
            <span v-for="(v, k) in c.scores" :key="k" class="score">{{ v ?? '—' }}</span>
            <span v-if="c.daysInStatus !== null"> · {{ t('candidate.daysInStatus', { n: c.daysInStatus }) }}</span>
          </div>
          <div v-if="c.accessUntil" class="sub">{{ t('candidate.accessUntil') }}: {{ dateOf(c.accessUntil) }}</div>
        </article>
        <p v-if="!col.cards.length" class="sub empty">{{ t('candidates.emptyColumn') }}</p>
        <button
          v-if="col.nextCursor" class="btn ghost" type="button"
          :disabled="busy === col.statusId" @click="loadMore(col)"
        >
          {{ t('common.loadMore') }}
        </button>
      </section>
    </div>

    <section v-else class="panel">
      <table class="table">
        <thead>
          <tr>
            <th>{{ t('candidates.col.name') }}</th>
            <th>{{ t('candidates.col.phone') }}</th>
            <th>{{ t('candidates.col.state') }}</th>
            <th>{{ t('candidates.col.recruiter') }}</th>
            <th>{{ t('candidates.col.added') }}</th>
          </tr>
        </thead>
        <tbody>
          <tr v-for="c in rows" :key="c.id">
            <td><NuxtLink class="link" :to="`/admin/candidates/${c.id}`">{{ c.fullName }}</NuxtLink></td>
            <td>{{ c.phone ?? '—' }}</td>
            <td>{{ t(`candidate.state.${c.state}`) }}</td>
            <td>{{ c.recruiterName ?? '—' }}</td>
            <td>{{ dateOf(c.createdAt) }}</td>
          </tr>
          <tr v-if="!rows.length"><td colspan="5" class="sub">{{ t('candidates.empty') }}</td></tr>
        </tbody>
      </table>
    </section>
  </div>
</template>

<style scoped>
.filters { display: flex; flex-wrap: wrap; gap: var(--space-2); align-items: end; margin-bottom: var(--space-3); }
.grow { flex: 1 1 14rem; }
.counter { color: var(--color-ink-muted); }
.tabs { display: flex; gap: var(--space-2); }
.tab { font: inherit; font-weight: 700; border: 1px solid var(--color-bg-line); background: transparent; color: var(--color-ink-muted); border-radius: var(--radius-pill); padding: var(--space-1) var(--space-4); cursor: pointer; }
.tab.on { color: var(--color-ink); border-color: var(--color-ink); }
.board { display: flex; gap: var(--space-3); overflow-x: auto; padding-bottom: var(--space-2); }
.column { flex: 0 0 16rem; display: flex; flex-direction: column; gap: var(--space-2); }
.col-head { display: flex; justify-content: space-between; align-items: center; padding: var(--space-1) var(--space-2); border-radius: var(--radius-pill); }
.kcard { background: var(--color-bg-soft); border: 1px solid var(--color-bg-line); border-radius: var(--radius-m); padding: var(--space-2); display: grid; gap: var(--space-1); }
.score { margin-right: var(--space-1); }
.empty { padding: var(--space-2); }
.table { width: 100%; border-collapse: collapse; }
.table th, .table td { text-align: left; padding: var(--space-1) var(--space-2); border-bottom: 1px solid var(--color-bg-line); }
.tone-sun { background: var(--color-sun-soft); }
.tone-teal { background: var(--color-teal-soft); }
.tone-coral { background: var(--color-coral-soft); }
.tone-ink { background: var(--color-bg-soft); }
@media (max-width: 480px) {
  .filters { flex-direction: column; align-items: stretch; }
  .column { flex: 0 0 85vw; }
}
</style>
