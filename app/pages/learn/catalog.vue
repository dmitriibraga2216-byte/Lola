<script setup lang="ts">
definePageMeta({ layout: 'learner' })

const { t } = useI18n()
const { api } = useApi()

interface CatalogCard {
  id: string
  title: string
  summary: string | null
  estimatedMinutes: number | null
  tags: string[]
  enrollmentId: string | null
}

const q = ref('')
const items = ref<CatalogCard[]>([])
const loading = ref(true)
const error = ref('')
const busyId = ref('')

async function load() {
  loading.value = true
  error.value = ''
  try {
    items.value = await api<CatalogCard[]>('/learning/catalog', { query: q.value ? { q: q.value } : {} })
  }
  catch (err) {
    error.value = apiErrorOf(err).message
  }
  finally {
    loading.value = false
  }
}

let timer: ReturnType<typeof setTimeout>
watch(q, () => {
  clearTimeout(timer)
  timer = setTimeout(load, 300)
})
onMounted(load)

async function enroll(card: CatalogCard) {
  busyId.value = card.id
  error.value = ''
  try {
    const res = await api<{ enrollmentId: string }>('/learning/enroll', { method: 'POST', body: { courseId: card.id } })
    await navigateTo(`/learn/${res.enrollmentId}`)
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
    <h1>{{ t('learner.nav.catalog') }}</h1>
    <input v-model="q" class="search" type="search" :placeholder="t('learner.searchCatalog')">

    <p v-if="error" class="error">{{ error }}</p>
    <p v-if="!loading && items.length === 0" class="empty">{{ t('learner.catalogEmpty') }}</p>

    <div class="grid">
      <div v-for="card in items" :key="card.id" class="card">
        <div class="title">{{ card.title }}</div>
        <p v-if="card.summary" class="summary">{{ card.summary }}</p>
        <div class="meta">
          <span v-if="card.estimatedMinutes">{{ t('learner.minutes', { n: card.estimatedMinutes }) }}</span>
        </div>
        <NuxtLink v-if="card.enrollmentId" :to="`/learn/${card.enrollmentId}`" class="btn ghost">
          {{ t('learner.alreadyEnrolled') }}
        </NuxtLink>
        <button v-else class="btn primary" :disabled="busyId === card.id" @click="enroll(card)">
          {{ t('learner.enroll') }}
        </button>
      </div>
    </div>
  </div>
</template>

<style scoped>
h1 {
  margin: 0 0 var(--space-3);
  font-weight: 900;
}

.search {
  width: 100%;
  box-sizing: border-box;
  font: inherit;
  border: 1px solid var(--color-bg-line);
  border-radius: var(--radius-pill);
  padding: var(--space-2) var(--space-4);
  background: var(--color-bg-soft);
  color: var(--color-ink);
  margin-bottom: var(--space-4);
}

.grid {
  display: grid;
  gap: var(--space-3);
  grid-template-columns: repeat(auto-fill, minmax(220px, 1fr));
}

.card {
  background: var(--color-bg-soft);
  border-radius: var(--radius-l);
  padding: var(--space-4);
  display: grid;
  gap: var(--space-2);
  align-content: start;
}

.title {
  font-weight: 800;
  font-size: var(--font-size-title-l);
}

.summary {
  margin: 0;
  color: var(--color-ink-muted);
  font-size: var(--font-size-body-s);
  overflow: hidden;
  display: -webkit-box;
  -webkit-line-clamp: 2;
  -webkit-box-orient: vertical;
}

.meta {
  color: var(--color-ink-faint);
  font-size: var(--font-size-body-s);
}

.btn {
  font: inherit;
  font-weight: 800;
  border: none;
  border-radius: var(--radius-pill);
  padding: var(--space-2) var(--space-4);
  text-align: center;
  text-decoration: none;
  cursor: pointer;
}

.primary {
  background: var(--color-sun);
  color: var(--color-ink);
}

.ghost {
  background: transparent;
  border: 1px solid var(--color-bg-line);
  color: var(--color-ink-muted);
}

.empty {
  color: var(--color-ink-faint);
  text-align: center;
  padding: var(--space-6);
}

.error {
  color: var(--color-coral-ink);
}
</style>
