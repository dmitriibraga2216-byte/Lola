<script setup lang="ts">
/** Каталог навчання (docs/10 §5.2, §14.1, мокап Catalog): вкладки «Завдання» / «Траєкторії». */
definePageMeta({ layout: 'learner' })

const { t } = useI18n()
const { api } = useApi()

type Tab = 'tasks' | 'trajectories'
const tab = ref<Tab>('tasks')

interface TaskCard {
  id: string
  type: 'course' | 'resource'
  title: string
  summary: string | null
  estimatedMinutes: number | null
  tags: string[]
  categoryId: string | null
  categoryName: string | null
  assignMode: 'catalog_free' | 'catalog_request'
  enrollmentId: string | null
  requested: boolean
}

// Мокап Catalog: обкладинка-плашка ліворуч від картки — кольорова заглушка (реальних
// обкладинок курсів ще не завантажують), колір циклічно чергується по картках.
const COVER_TONES = ['sun', 'teal', 'coral'] as const
function coverTone(i: number): string { return COVER_TONES[i % COVER_TONES.length]! }

interface TrajCard {
  id: string
  type: 'program' | 'trajectory'
  title: string
  description: string | null
  coverKey: string | null
  tags: string[]
  assignMode: string
  status: string | null
  requested: boolean
}

const q = ref('')
const categoryId = ref('')
const tasks = ref<TaskCard[]>([])
const trajectories = ref<TrajCard[]>([])
const loading = ref(true)
const error = ref('')
const notice = ref('')
const busyId = ref('')

const categories = computed(() => {
  const seen = new Map<string, string>()
  for (const c of tasks.value) if (c.categoryId && c.categoryName) seen.set(c.categoryId, c.categoryName)
  return [...seen.entries()].map(([id, name]) => ({ id, name }))
})

async function load() {
  loading.value = true
  error.value = ''
  try {
    if (tab.value === 'tasks') {
      tasks.value = await api<TaskCard[]>('/me/catalog', { query: { kind: 'tasks', q: q.value || undefined, category: categoryId.value || undefined } })
    }
    else {
      trajectories.value = await api<TrajCard[]>('/me/catalog', { query: { kind: 'trajectories' } })
    }
  }
  catch (err) {
    error.value = apiErrorOf(err).message
  }
  finally {
    loading.value = false
  }
}

let timer: ReturnType<typeof setTimeout>
watch(q, () => { clearTimeout(timer); timer = setTimeout(load, 300) })
watch(categoryId, load)
watch(tab, load)
onMounted(load)

// Мокап Catalog: картка веде на попередній перегляд («Детальніше»), а не одразу на запис —
// сама дія (запис / заявка / відкриття ресурсу) — кнопка всередині панелі перегляду.
const previewCard = ref<TaskCard | null>(null)

const requestModal = ref<TaskCard | null>(null)
const requestComment = ref('')

async function enrollTask(card: TaskCard) {
  previewCard.value = null
  // Ресурс бази знань відкривається напряму — самозапису/заявки для ресурсу не заведено (docs/33 D-060).
  // Екран читання ресурсу — `knowledge/lesson/:id`; `knowledge/:id` — стаття бази знань, ресурс там «не знайдено»
  if (card.type === 'resource') { await navigateTo(`/learn/knowledge/lesson/${card.id}`); return }
  if (card.assignMode === 'catalog_request') { requestModal.value = card; requestComment.value = ''; return }
  busyId.value = card.id
  error.value = ''
  try {
    const res = await api<{ enrollmentId: string }>(`/me/catalog/${card.id}/enroll`, { method: 'POST' })
    await navigateTo(`/learn/${res.enrollmentId}`)
  }
  catch (err) {
    error.value = apiErrorOf(err).message
  }
  finally {
    busyId.value = ''
  }
}

async function submitRequest() {
  if (!requestModal.value) return
  busyId.value = requestModal.value.id
  error.value = ''
  try {
    await api(`/me/catalog/${requestModal.value.id}/request`, { method: 'POST', body: { comment: requestComment.value.trim() || undefined } })
    notice.value = t('learner.catalogRequestSent')
    requestModal.value = null
    await load()
  }
  catch (err) {
    error.value = apiErrorOf(err).message
  }
  finally {
    busyId.value = ''
  }
}

async function enrollTraj(card: TrajCard) {
  busyId.value = card.id
  error.value = ''
  try {
    const path = card.type === 'program' ? `/learning/programs/${card.id}/enroll` : `/me/trajectories/catalog/${card.id}/enroll`
    const res = await api<{ requested?: boolean }>(path, { method: 'POST', body: {} })
    notice.value = res.requested ? t('learner.catalogRequestSent') : t('learner.enrolled')
    await load()
  }
  catch (err) {
    error.value = apiErrorOf(err).message
  }
  finally {
    busyId.value = ''
  }
}
</script>

<template>
  <div>
    <h1 class="title">{{ t('learner.nav.catalog') }}</h1>

    <div class="chips tabs" role="tablist">
      <button type="button" role="tab" :aria-selected="tab === 'tasks'" :class="['chip', { on: tab === 'tasks' }]" @click="tab = 'tasks'">{{ t('learner.catalogTabTasks') }}</button>
      <button type="button" role="tab" :aria-selected="tab === 'trajectories'" :class="['chip', { on: tab === 'trajectories' }]" @click="tab = 'trajectories'">{{ t('learner.catalogTabTrajectories') }}</button>
    </div>

    <template v-if="tab === 'tasks'">
      <input v-model="q" class="search" type="search" :placeholder="t('learner.searchCatalog')" :aria-label="t('learner.searchCatalog')">

      <div v-if="categories.length" class="chips cats">
        <button type="button" :class="['chip', { on: !categoryId }]" @click="categoryId = ''">{{ t('learner.catalogAllCategories') }}</button>
        <button v-for="c in categories" :key="c.id" type="button" :class="['chip', { on: categoryId === c.id }]" @click="categoryId = c.id">{{ c.name }}</button>
      </div>
    </template>

    <p v-if="error" class="error-text" role="alert">{{ error }}</p>
    <p v-if="notice" class="note teal">{{ notice }}</p>

    <template v-if="tab === 'tasks'">
      <p v-if="!loading && tasks.length === 0" class="empty">{{ t('learner.catalogEmpty') }}</p>
      <div class="grid">
        <div v-for="(card, i) in tasks" :key="`${card.type}:${card.id}`" class="card">
          <div :class="['cover', coverTone(i)]" aria-hidden="true" />
          <div class="card-body">
            <div class="title2">{{ card.title }}</div>
            <p v-if="card.summary" class="summary">{{ card.summary }}</p>
            <div class="meta">
              <span v-if="card.estimatedMinutes">{{ t('learner.minutes', { n: card.estimatedMinutes }) }}</span>
            </div>
            <div class="row">
              <span class="badge muted">{{ card.assignMode === 'catalog_request' ? t('learner.catalogRequestMode') : t('learner.catalogFreeMode') }}</span>
              <NuxtLink v-if="card.enrollmentId" :to="`/learn/${card.enrollmentId}`" class="btn ghost small">{{ t('learner.alreadyEnrolled') }}</NuxtLink>
              <span v-else-if="card.requested" class="badge sun">{{ t('learner.catalogRequested') }}</span>
              <button v-else type="button" class="btn ghost small" @click="previewCard = card">{{ t('learner.catalogDetails') }}</button>
            </div>
          </div>
        </div>
      </div>
    </template>

    <template v-else>
      <p v-if="!loading && trajectories.length === 0" class="empty">{{ t('learner.catalogEmpty') }}</p>
      <div class="grid">
        <div v-for="card in trajectories" :key="`${card.type}:${card.id}`" class="card">
          <div class="title2">{{ card.title }}</div>
          <p v-if="card.description" class="summary">{{ card.description }}</p>
          <div class="row">
            <span class="badge muted">{{ card.assignMode === 'catalog_request' ? t('learner.catalogRequestMode') : t('learner.catalogFreeMode') }}</span>
            <span v-if="card.status && card.status !== 'not_assigned'" class="badge">{{ t(`learner.catalogStatus.${card.status}`) }}</span>
            <span v-else-if="card.requested" class="badge sun">{{ t('learner.catalogRequested') }}</span>
            <button v-else class="btn primary small" :disabled="busyId === card.id" @click="enrollTraj(card)">
              {{ card.assignMode === 'catalog_request' ? t('learner.catalogRequestButton') : t('learner.enroll') }}
            </button>
          </div>
        </div>
      </div>
    </template>

    <div v-if="previewCard" class="modal-backdrop" role="dialog" aria-modal="true" :aria-label="previewCard.title" @click.self="previewCard = null">
      <div class="modal">
        <h2>{{ previewCard.title }}</h2>
        <p v-if="previewCard.summary" class="sub">{{ previewCard.summary }}</p>
        <div class="meta preview-meta">
          <span v-if="previewCard.estimatedMinutes">{{ t('learner.minutes', { n: previewCard.estimatedMinutes }) }}</span>
          <span class="badge muted">{{ previewCard.assignMode === 'catalog_request' ? t('learner.catalogRequestMode') : t('learner.catalogFreeMode') }}</span>
        </div>
        <div class="actions">
          <button class="btn primary" :disabled="busyId === previewCard.id" @click="enrollTask(previewCard)">
            {{ previewCard.type === 'resource' ? t('learner.catalogOpenResource') : (previewCard.assignMode === 'catalog_request' ? t('learner.catalogRequestButton') : t('learner.enroll')) }}
          </button>
          <button class="btn ghost" @click="previewCard = null">{{ t('common.cancel') }}</button>
        </div>
      </div>
    </div>

    <div v-if="requestModal" class="modal-backdrop" role="dialog" aria-modal="true" :aria-label="t('learner.catalogRequestTitle')">
      <div class="modal">
        <h2>{{ t('learner.catalogRequestTitle') }}</h2>
        <p class="sub">{{ requestModal.title }}</p>
        <label class="label" for="req-comment">{{ t('learner.catalogRequestCommentLabel') }}</label>
        <textarea id="req-comment" v-model="requestComment" class="field" rows="3" maxlength="300" />
        <div class="actions">
          <button class="btn primary" :disabled="busyId === requestModal.id" @click="submitRequest">{{ t('learner.catalogRequestSubmit') }}</button>
          <button class="btn ghost" @click="requestModal = null">{{ t('common.cancel') }}</button>
        </div>
      </div>
    </div>
  </div>
</template>

<style scoped>
.title { margin: 0 0 var(--space-3); font-weight: 900; }
.tabs { margin-bottom: var(--space-3); }
.cats { margin: var(--space-2) 0 var(--space-3); }

.search {
  width: 100%;
  box-sizing: border-box;
  font: inherit;
  border: 1px solid var(--color-bg-line);
  border-radius: var(--radius-pill);
  padding: var(--space-2) var(--space-4);
  background: var(--color-bg-soft);
  color: var(--color-ink);
  margin-bottom: var(--space-3);
}

.grid { display: grid; gap: var(--space-3); grid-template-columns: repeat(auto-fill, minmax(220px, 1fr)); }
.card { background: var(--color-bg-soft); border-radius: var(--radius-l); padding: var(--space-4); display: flex; gap: var(--space-3); align-items: flex-start; }
.card-body { flex: 1; min-width: 0; display: grid; gap: var(--space-2); align-content: start; }
.cover { width: 66px; height: 66px; flex: none; border-radius: var(--radius-m); }
.cover.sun { background: var(--color-sun); }
.cover.teal { background: var(--color-teal); }
.cover.coral { background: var(--color-coral); }
.title2 { font-weight: 800; font-size: var(--font-size-title-l); }
.summary { margin: 0; color: var(--color-ink-muted); font-size: var(--font-size-body-s); overflow: hidden; display: -webkit-box; -webkit-line-clamp: 2; -webkit-box-orient: vertical; }
.meta { color: var(--color-ink-faint); font-size: var(--font-size-body-s); }
.row { display: flex; justify-content: space-between; align-items: center; gap: var(--space-2); flex-wrap: wrap; }

.btn { font: inherit; font-weight: 800; border: none; border-radius: var(--radius-pill); padding: var(--space-2) var(--space-4); text-align: center; text-decoration: none; cursor: pointer; }
.btn.small { padding: var(--space-1) var(--space-3); font-size: var(--font-size-body-s); }
.primary { background: var(--color-sun); color: var(--color-ink); }
.ghost { background: transparent; border: 1px solid var(--color-bg-line); color: var(--color-ink-muted); }

.empty { color: var(--color-ink-faint); text-align: center; padding: var(--space-6); }
.error-text { color: var(--color-coral-ink); }

.modal-backdrop { position: fixed; inset: 0; background: rgba(12, 15, 20, 0.5); display: flex; align-items: center; justify-content: center; padding: var(--space-4); z-index: 50; }
.modal { background: var(--color-bg); border-radius: var(--radius-l); padding: var(--space-5); max-width: 420px; width: 100%; display: grid; gap: var(--space-2); }
.modal .sub { color: var(--color-ink-muted); margin: 0 0 var(--space-2); }
.preview-meta { display: flex; align-items: center; gap: var(--space-2); flex-wrap: wrap; }
.label { font-weight: 700; font-size: var(--font-size-body-s); }
.field { font: inherit; width: 100%; box-sizing: border-box; border: 1px solid var(--color-bg-line); border-radius: var(--radius-m); padding: var(--space-2) var(--space-3); background: var(--color-bg-soft); color: var(--color-ink); }
.actions { display: flex; gap: var(--space-2); margin-top: var(--space-2); }
</style>
