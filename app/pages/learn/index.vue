<script setup lang="ts">
definePageMeta({ layout: 'learner' })

const { t } = useI18n()
const { me, hasScope } = useAuth()
const sections = computed(() => [
  { to: '/learn/meetups', label: t('mt.short') }, { to: '/learn/knowledge', label: t('kb.short') }, { to: '/learn/news', label: t('news.short') }, { to: '/learn/development', label: t('dev.short') },
  { to: '/learn/assessment', label: t('assess.short') }, { to: '/learn/certificates', label: t('learner.certificates') }, { to: '/learn/surveys', label: t('survey.short') },
  ...(hasScope('checklist.run') ? [{ to: '/learn/checklists', label: t('cl.short') }] : []),
])
const { api } = useApi()

interface Card {
  id: string
  status: string
  progressPct: string
  dueAt: string | null
  title: string
  estimatedMinutes: number | null
  requiredTotal: number
  requiredDone: number
}

const tab = ref<'active' | 'overdue' | 'done'>('active')
const items = ref<Card[]>([])
const loading = ref(true)
const error = ref('')

async function load() {
  loading.value = true
  error.value = ''
  try {
    items.value = await api<Card[]>('/learning/my', { query: { tab: tab.value } })
  }
  catch (err) {
    error.value = apiErrorOf(err).message
  }
  finally {
    loading.value = false
  }
}
watch(tab, load)
onMounted(load)

const withDeadline = computed(() => items.value.filter(i => i.dueAt).length)

function dueLabel(card: Card): { text: string, urgent: boolean } | null {
  if (!card.dueAt) return null
  const due = new Date(card.dueAt)
  const days = Math.ceil((due.getTime() - Date.now()) / 86_400_000)
  return {
    text: t('learner.dueBy', { date: due.toLocaleDateString('uk', { day: 'numeric', month: 'long' }) }),
    urgent: days <= 3,
  }
}

function action(card: Card): string {
  if (card.status === 'completed') return t('learner.action.review')
  if (card.status === 'in_progress') return t('learner.action.continue')
  return t('learner.action.start')
}

function initial(title: string) {
  return title.trim().charAt(0).toUpperCase()
}

const emptyText = computed(() => t(`learner.empty.${tab.value}`))
</script>

<template>
  <div>
    <h1 class="hello">{{ t('learner.hello', { name: me?.user.fullName.split(' ')[0] || '' }) }}</h1>
    <p class="counter">
      {{ t('learner.counter', { n: items.length, deadlines: withDeadline }) }}
    </p>

    <nav class="sections">
      <NuxtLink v-for="sct in sections" :key="sct.to" :to="sct.to" class="section">{{ sct.label }}</NuxtLink>
    </nav>

    <div class="tabs">
      <button
        v-for="option in (['active', 'overdue', 'done'] as const)"
        :key="option"
        :class="['tab', { on: tab === option }]"
        @click="tab = option"
      >
        {{ t(`learner.tab.${option}`) }}
      </button>
    </div>

    <p v-if="error" class="error">{{ error }}</p>

    <div v-if="loading" class="cards">
      <div v-for="i in 3" :key="i" class="card skeleton" />
    </div>

    <div v-else-if="items.length === 0" class="empty">
      <p>{{ emptyText }}</p>
      <NuxtLink to="/learn/catalog" class="link">{{ t('learner.browseCatalog') }}</NuxtLink>
    </div>

    <div v-else class="cards">
      <NuxtLink v-for="card in items" :key="card.id" :to="`/learn/${card.id}`" class="card">
        <div class="cover">{{ initial(card.title) }}</div>
        <div class="body">
          <div class="title">{{ card.title }}</div>
          <div class="meta">
            <span>{{ t('learner.lessons', { n: card.requiredTotal }) }}</span>
            <span v-if="card.estimatedMinutes"> · {{ t('learner.minutes', { n: card.estimatedMinutes }) }}</span>
            <span v-if="dueLabel(card)" :class="{ urgent: dueLabel(card)!.urgent }"> · {{ dueLabel(card)!.text }}</span>
          </div>
          <div class="progress">
            <div class="bar" :style="{ width: `${card.progressPct}%` }" />
          </div>
          <div class="row">
            <span v-if="card.status === 'expired'" class="badge coral">{{ t('learner.badge.expired') }}</span>
            <span v-else-if="card.status === 'completed'" class="badge teal">{{ t('learner.badge.completed') }}</span>
            <span v-else class="pct">{{ Number(card.progressPct) }}%</span>
            <span class="action">{{ action(card) }}</span>
          </div>
        </div>
      </NuxtLink>
    </div>
  </div>
</template>

<style scoped>
.hello {
  margin: 0;
  font-weight: 900;
  font-size: var(--font-size-display);
}

.counter {
  margin: var(--space-1) 0 var(--space-4);
  color: var(--color-ink-muted);
}

.sections { display: flex; gap: var(--space-1); overflow-x: auto; margin-bottom: var(--space-3); padding-bottom: 2px; }
.section { white-space: nowrap; font-weight: 700; font-size: var(--font-size-body-s); color: var(--color-ink); text-decoration: none; background: var(--color-bg-soft); border-radius: var(--radius-pill); padding: var(--space-2) var(--space-3); }

.tabs {
  display: flex;
  gap: var(--space-2);
  margin-bottom: var(--space-4);
}

.tab {
  font: inherit;
  font-weight: 700;
  border: 1px solid var(--color-bg-line);
  background: transparent;
  color: var(--color-ink-muted);
  border-radius: var(--radius-pill);
  padding: var(--space-1) var(--space-4);
  cursor: pointer;
}

.tab.on {
  background: var(--color-ink);
  border-color: var(--color-ink);
  color: var(--color-bg-soft);
}

.cards {
  display: grid;
  gap: var(--space-3);
}

.card {
  display: flex;
  gap: var(--space-3);
  background: var(--color-bg-soft);
  border-radius: var(--radius-l);
  padding: var(--space-3);
  text-decoration: none;
  color: inherit;
}

.card.skeleton {
  height: 96px;
  opacity: 0.5;
}

.cover {
  width: 72px;
  height: 72px;
  flex: none;
  border-radius: var(--radius-s);
  background: var(--color-teal);
  color: var(--color-teal-deep);
  display: grid;
  place-items: center;
  font-weight: 900;
  font-size: var(--font-size-display);
}

.body {
  flex: 1;
  min-width: 0;
  display: grid;
  gap: var(--space-1);
}

.title {
  font-weight: 800;
  font-size: var(--font-size-title-l);
  overflow: hidden;
  display: -webkit-box;
  -webkit-line-clamp: 2;
  -webkit-box-orient: vertical;
}

.meta {
  font-size: var(--font-size-body-s);
  color: var(--color-ink-muted);
}

.urgent {
  color: var(--color-coral-ink);
  font-weight: 700;
}

.progress {
  height: 6px;
  background: var(--color-bg-line-soft);
  border-radius: var(--radius-pill);
  overflow: hidden;
}

.bar {
  height: 100%;
  background: var(--color-teal);
  border-radius: var(--radius-pill);
}

.row {
  display: flex;
  justify-content: space-between;
  align-items: center;
  font-size: var(--font-size-body-s);
}

.pct {
  color: var(--color-teal-ink);
  font-weight: 700;
}

.action {
  font-weight: 800;
  color: var(--color-ink);
  background: var(--color-sun);
  border-radius: var(--radius-pill);
  padding: 2px var(--space-3);
}

.badge {
  font-weight: 700;
  border-radius: var(--radius-pill);
  padding: 2px var(--space-3);
}

.badge.coral { background: var(--color-coral); color: var(--color-coral-deep); }
.badge.teal { background: var(--color-teal); color: var(--color-teal-deep); }

.empty {
  text-align: center;
  padding: var(--space-7) var(--space-4);
  color: var(--color-ink-muted);
}

.link {
  color: var(--color-teal-ink);
  font-weight: 700;
}

.error {
  color: var(--color-coral-ink);
}
</style>
