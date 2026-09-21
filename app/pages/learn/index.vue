<script setup lang="ts">
definePageMeta({ layout: 'learner' })

const { t } = useI18n()
const { me, hasScope } = useAuth()
const route = useRoute()
const sections = computed(() => [
  { to: '/learn/trajectories', label: t('traj.short') }, { to: '/learn/programs', label: t('prog.short') }, { to: '/learn/meetups', label: t('mt.short') }, { to: '/learn/knowledge', label: t('kb.short') }, { to: '/learn/wiki', label: t('wiki.short') }, { to: '/learn/org', label: t('org.short') }, { to: '/learn/news', label: t('news.short') }, { to: '/learn/development', label: t('dev.short') },
  { to: '/learn/assessment', label: t('assess.short') }, { to: '/learn/certificates', label: t('learner.certificates') }, { to: '/learn/surveys', label: t('survey.short') },
  ...(hasScope('checklist.run') ? [{ to: '/learn/checklists', label: t('cl.short') }] : []),
])
const { api } = useApi()

/** Пять групп эталона (docs/04 §4.4) в API; на экране — три чипа мокапа MyTasks: актуальні = new+planned+failed. */
type Group = 'new' | 'planned' | 'failed' | 'overdue' | 'done'
type Tab = 'active' | 'overdue' | 'done'
interface Card {
  id: string
  status: string
  group: Group
  planned: boolean
  overdue: boolean
  autoClosed: boolean
  progressPct: string
  dueAt: string | null
  startsAt: string | null
  title: string
  estimatedMinutes: number | null
  requiredTotal: number
  requiredDone: number
}

const tab = ref<Tab>((['active', 'overdue', 'done'] as const).includes(route.query.tab as Tab) ? route.query.tab as Tab : 'active')
const items = ref<Card[]>([])
const counts = ref<Record<Group, number>>({ new: 0, planned: 0, failed: 0, overdue: 0, done: 0 })
const loading = ref(true)
const error = ref('')

const tabGroups: Record<Tab, Group[]> = { active: ['new', 'planned', 'failed'], overdue: ['overdue'], done: ['done'] }
const tabCount = (x: Tab) => tabGroups[x].reduce((s, g) => s + (counts.value[g] ?? 0), 0)

async function load() {
  loading.value = true
  error.value = ''
  try {
    const lists = await Promise.all(tabGroups[tab.value].map(g => api<{ items: Card[], counts: Record<Group, number> }>('/learning/my', { query: { group: g, counts: 1 } })))
    counts.value = lists[0]!.counts
    items.value = lists.flatMap(l => l.items)
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

/** Группы списка по мокапу MyTasks: «Прострочено · Цього тижня · Пізніше» (по сроку). */
type Bucket = 'overdue' | 'week' | 'later'
function bucketOf(card: Card): Bucket {
  if (card.overdue) return 'overdue'
  if (card.dueAt && +new Date(card.dueAt) - Date.now() <= 7 * 86_400_000) return 'week'
  return 'later'
}
const buckets = computed(() => (['overdue', 'week', 'later'] as Bucket[])
  .map(b => ({ key: b, items: items.value.filter(c => bucketOf(c) === b) }))
  .filter(b => b.items.length > 0))
const grouped = computed(() => tab.value === 'active' && buckets.value.length > 1)

function dueBadge(card: Card): string {
  const due = new Date(card.dueAt!)
  const days = Math.round((Date.UTC(due.getFullYear(), due.getMonth(), due.getDate()) - Date.UTC(new Date().getFullYear(), new Date().getMonth(), new Date().getDate())) / 86_400_000)
  if (days === 0) return t('learner.badge.today')
  if (days === -1) return t('learner.badge.yesterday')
  if (days < -1) return t('learner.badge.overdueDays', { n: -days })
  if (days === 1) return t('learner.badge.tomorrow')
  return t('learner.badge.due', { date: shortDate(card.dueAt!) })
}

function shortDate(iso: string) {
  const d = new Date(iso)
  return `${String(d.getDate()).padStart(2, '0')}.${String(d.getMonth() + 1).padStart(2, '0')}`
}
function longDate(iso: string) {
  return new Date(iso).toLocaleDateString('uk', { day: 'numeric', month: 'long' })
}

function action(card: Card): string {
  if (card.status === 'done') return t('learner.action.review')
  if (card.status === 'failed') return t('learner.action.retry')
  if (card.status === 'in_progress') return t('learner.action.continue')
  // Мокап MyTasks: не розпочатий курс/ознайомлення відкривають («Відкрити»), окремого типу
  // «тест» (кнопка «Пройти») цей список поки не розрізняє — /learning/my віддає лише курси
  // (docs/31 рядок MyTasks); тип предмета в відповіді сервера — окремий борг, не вигадуємо.
  return t('learner.action.open')
}
function stateLine(card: Card): string {
  if (card.status === 'done') return t('learner.state.progress', { pct: 100 })
  if (card.status === 'failed') return card.autoClosed ? t('learner.state.autoClosed') : t('learner.state.failed')
  if (card.status === 'in_progress') return t('learner.state.progress', { pct: Math.round(Number(card.progressPct)) })
  return t('learner.state.notStarted')
}

const emptyText = computed(() => t(`learner.empty.${tab.value}`))
</script>

<template>
  <div>
    <div class="greet-row">
      <div>
        <p class="greet">{{ t('learner.greeting') }}</p>
        <h1 class="hello">{{ me?.user.fullName.split(' ')[1] || me?.user.fullName.split(' ')[0] || '' }}</h1>
      </div>
      <NotificationBell />
    </div>

    <div class="chips" role="tablist">
      <button
        v-for="option in (['active', 'overdue', 'done'] as const)"
        :key="option"
        role="tab"
        :aria-selected="tab === option"
        :class="['chip', option, { on: tab === option }]"
        @click="tab = option"
      >
        {{ t(`learner.tab.${option}`) }}<template v-if="tabCount(option) > 0"> · {{ tabCount(option) }}</template>
      </button>
    </div>

    <p v-if="error" class="error">{{ error }}</p>

    <div v-if="loading" class="cards">
      <div v-for="i in 3" :key="i" class="card skeleton" />
    </div>

    <div v-else-if="items.length === 0" class="empty">
      <p class="empty-title">{{ t('learner.emptyTitle') }}</p>
      <p>{{ emptyText }}</p>
      <NuxtLink v-if="tab === 'active'" to="/learn/catalog" class="btn primary">{{ t('learner.browseCatalog') }}</NuxtLink>
    </div>

    <template v-else>
      <template v-for="b in (grouped ? buckets : [{ key: 'all', items }])" :key="b.key">
        <h2 v-if="grouped" class="bucket">{{ t(`learner.bucket.${b.key}`) }} <span class="bucket-n">{{ b.items.length }}</span></h2>
        <div class="cards">
          <NuxtLink v-for="card in b.items" :key="card.id" :to="`/learn/${card.id}`" :class="['card', { coral: card.overdue }]" :data-testid="`task-${card.status}`">
        <div class="head">
          <div class="title">{{ card.title }}</div>
          <span v-if="card.overdue" class="badge coral">{{ dueBadge(card) }}</span>
          <span v-else-if="card.planned && card.startsAt" class="badge muted">{{ t('learner.badge.planned', { date: longDate(card.startsAt) }) }}</span>
          <span v-else-if="card.status === 'done'" class="badge teal">{{ t('learner.badge.completed') }}</span>
          <span v-else-if="card.status === 'failed'" class="badge coral">{{ t('learner.badge.failed') }}</span>
          <span v-else-if="card.dueAt" class="badge sun">{{ dueBadge(card) }}</span>
        </div>
        <div class="meta">
          {{ t('learner.metaCourse', { n: card.requiredTotal }) }}<template v-if="card.estimatedMinutes"> · {{ t('learner.minutes', { n: card.estimatedMinutes }) }}</template><template v-if="card.dueAt"> · {{ t('learner.dueBy', { date: longDate(card.dueAt) }) }}</template>
        </div>
        <div v-if="card.status === 'in_progress'" class="progress">
          <div class="bar" :style="{ width: `${card.progressPct}%` }" />
        </div>
        <div class="row">
          <span class="state">{{ stateLine(card) }}</span>
          <span class="action">{{ action(card) }}</span>
        </div>
      </NuxtLink>
        </div>
      </template>
    </template>

    <nav class="sections" :aria-label="t('learner.sections')">
      <NuxtLink v-for="sct in sections" :key="sct.to" :to="sct.to" class="section">{{ sct.label }}</NuxtLink>
    </nav>
    <p class="counter">{{ t('learner.counter', { n: items.length, deadlines: withDeadline }) }}</p>
  </div>
</template>

<style scoped>
.greet-row { display: flex; align-items: center; justify-content: space-between; gap: var(--space-3); }
.greet { margin: 0; color: var(--color-ink-muted); font-weight: 700; font-size: var(--font-size-body-s); }
.bucket { margin: var(--space-4) 0 var(--space-2); font-size: 12px; font-weight: 800; letter-spacing: 0.06em; text-transform: uppercase; color: var(--color-ink-muted); display: flex; gap: var(--space-2); }
.bucket-n { color: var(--color-ink-faint); }
.hello { margin: 2px 0 0; font-weight: 900; font-size: 28px; letter-spacing: -0.02em; }

.chips { display: flex; gap: var(--space-2); margin: var(--space-4) 0 var(--space-3); overflow-x: auto; padding-bottom: 2px; }
.chip {
  font: inherit; font-weight: 800; font-size: var(--font-size-body-s); line-height: 16px; white-space: nowrap;
  border: 1px solid transparent; background: var(--color-bg-soft); color: var(--color-ink-muted);
  border-radius: var(--radius-pill); padding: var(--space-1) var(--space-3); cursor: pointer;
}
.chip.on { background: var(--color-ink); color: var(--color-bg); }
.chip.overdue.on { background: var(--color-coral); color: var(--color-coral-deep); }

.cards { display: grid; gap: var(--space-3); }
.card {
  display: grid; gap: var(--space-2);
  background: var(--color-bg-soft); border: 2px solid transparent; border-radius: var(--radius-m);
  padding: var(--space-4); text-decoration: none; color: inherit;
}
.card.coral { border-color: var(--color-coral); }
.card.skeleton { height: 120px; opacity: 0.5; }
.head { display: flex; align-items: flex-start; justify-content: space-between; gap: var(--space-3); }
.title { font-weight: 900; font-size: var(--font-size-title-l); line-height: 1.2; }
.meta { color: var(--color-ink-muted); font-size: var(--font-size-body-s); }
.progress { height: 6px; border-radius: var(--radius-pill); background: var(--color-bg-line-soft); overflow: hidden; }
.bar { height: 100%; background: var(--color-teal); border-radius: var(--radius-pill); }
.row { display: flex; align-items: center; justify-content: space-between; gap: var(--space-3); margin-top: var(--space-1); }
.state { color: var(--color-ink-muted); font-weight: 700; font-size: var(--font-size-body-s); }
.action {
  background: var(--color-sun); color: var(--color-ink); font-weight: 800; font-size: var(--font-size-body-s);
  border-radius: var(--radius-pill); padding: var(--space-2) var(--space-4);
}
.badge {
  flex: none; font-size: 12px; font-weight: 800; line-height: 16px; white-space: nowrap;
  border-radius: var(--radius-pill); padding: var(--space-1) var(--space-3);
}
.badge.sun { background: var(--color-sun); color: var(--color-ink); }
.badge.coral { background: var(--color-coral); color: var(--color-coral-deep); }
.badge.teal { background: var(--color-teal); color: var(--color-teal-deep); }
.badge.muted { background: var(--color-bg-line-soft); color: var(--color-ink-muted); }

.empty { text-align: center; padding: var(--space-7) var(--space-4); color: var(--color-ink-muted); display: grid; gap: var(--space-3); justify-items: center; }
.empty-title { margin: 0; font-size: var(--font-size-title-l); font-weight: 900; color: var(--color-ink); }
.link { color: var(--color-teal-ink); font-weight: 700; }
.error { color: var(--color-coral-ink); }

.sections { display: flex; gap: var(--space-1); overflow-x: auto; margin: var(--space-5) 0 var(--space-2); padding-bottom: 2px; }
.section { white-space: nowrap; font-weight: 700; font-size: var(--font-size-body-s); color: var(--color-ink); text-decoration: none; background: var(--color-bg-soft); border-radius: var(--radius-pill); padding: var(--space-2) var(--space-3); }
.counter { margin: 0; color: var(--color-ink-faint); font-size: var(--font-size-body-s); }
</style>
