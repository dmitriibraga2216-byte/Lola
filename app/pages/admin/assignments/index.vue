<script setup lang="ts">
definePageMeta({ layout: 'admin', middleware: 'admin-scope', requiredScope: 'assignment.create' })

const { t } = useI18n()
const { api } = useApi()

interface Row {
  id: string
  title: string
  kind: string
  status: string
  dueMode: string
  dueAt: string | null
  dueDays: number | null
  isMandatory: boolean
  authorName: string | null
  createdAt: string
  stats: { assigned?: number, started?: number, completed?: number, overdue?: number }
}

// Вкладки эталона (task_type, docs/02): manual | auto | catalog | trajectory | archive
const tab = ref<'all' | 'manual' | 'auto' | 'catalog' | 'trajectory' | 'archived'>('all')
const items = ref<Row[]>([])
const error = ref('')

async function load() {
  try {
    const query = tab.value === 'archived' ? { status: 'archived' } : tab.value === 'all' ? {} : { kind: tab.value }
    items.value = await api<Row[]>('/assignments', { query })
  }
  catch (err) {
    error.value = apiErrorOf(err).message
  }
}
watch(tab, load)
onMounted(load)

function due(r: Row) {
  if (r.dueMode === 'absolute' && r.dueAt) return new Date(r.dueAt).toLocaleDateString('uk')
  if (r.dueMode === 'relative') return t('assign.relDays', { n: r.dueDays })
  return '—'
}
</script>

<template>
  <div>
    <header class="head">
      <h1>{{ t('admin.nav.assignments') }}</h1>
      <NuxtLink to="/admin/assignments/new" class="primary">{{ t('assign.new') }}</NuxtLink>
    </header>
    <div class="tabs">
      <button v-for="k in (['all', 'manual', 'auto', 'catalog', 'trajectory', 'archived'] as const)" :key="k" :class="['tab', { on: tab === k }]" @click="tab = k">
        {{ t(`assign.tab.${k}`) }}
      </button>
    </div>
    <p v-if="error" class="error">{{ error }}</p>
    <table class="table">
      <thead>
        <tr>
          <th>{{ t('assign.col.title') }}</th><th>{{ t('assign.col.kind') }}</th><th>{{ t('assign.col.author') }}</th>
          <th>{{ t('assign.col.due') }}</th><th>{{ t('assign.col.people') }}</th><th>{{ t('assign.col.progress') }}</th><th>{{ t('assign.col.status') }}</th>
        </tr>
      </thead>
      <tbody>
        <tr v-for="r in items" :key="r.id" class="row" @click="navigateTo(`/admin/assignments/${r.id}`)">
          <td><b>{{ r.title }}</b><span v-if="r.isMandatory" class="sub"> · {{ t('assign.mandatory') }}</span></td>
          <td>{{ t(`assign.kind.${r.kind}`) }}</td>
          <td class="sub">{{ r.authorName || '—' }}</td>
          <td>{{ due(r) }}</td>
          <td>{{ r.stats.assigned ?? 0 }}</td>
          <td>
            <span class="teal">{{ r.stats.completed ?? 0 }}</span> / <span class="coral">{{ r.stats.overdue ?? 0 }}</span>
          </td>
          <td><span :class="['badge', r.status]">{{ t(`assign.status.${r.status}`) }}</span></td>
        </tr>
        <tr v-if="items.length === 0"><td colspan="7" class="empty">{{ t('assign.empty') }}</td></tr>
      </tbody>
    </table>
  </div>
</template>

<style scoped>
.head { display: flex; align-items: center; gap: var(--space-4); margin-bottom: var(--space-4); }
h1 { margin: 0; font-weight: 900; }
.primary { margin-left: auto; font-weight: 800; background: var(--color-sun); color: var(--color-ink); border-radius: var(--radius-pill); padding: var(--space-2) var(--space-4); text-decoration: none; }
.tabs { display: flex; gap: var(--space-2); margin-bottom: var(--space-4); flex-wrap: wrap; }
.tab { font: inherit; font-weight: 700; border: 1px solid var(--color-bg-line); background: transparent; color: var(--color-ink-muted); border-radius: var(--radius-pill); padding: var(--space-1) var(--space-4); cursor: pointer; }
.tab.on { background: var(--color-ink); border-color: var(--color-ink); color: var(--color-bg-soft); }
.table { width: 100%; border-collapse: collapse; background: var(--color-bg-soft); border-radius: var(--radius-m); overflow: hidden; }
th { text-align: left; font-size: var(--font-size-body-s); color: var(--color-ink-muted); padding: var(--space-2) var(--space-3); border-bottom: 1px solid var(--color-bg-line); }
td { padding: var(--space-3); border-bottom: 1px solid var(--color-bg-line-soft); }
.row { cursor: pointer; }
.row:hover { background: var(--color-bg); }
.sub { font-size: var(--font-size-body-s); color: var(--color-ink-faint); }
.teal { color: var(--color-teal-ink); font-weight: 700; }
.coral { color: var(--color-coral-ink); font-weight: 700; }
.badge { font-size: var(--font-size-body-s); font-weight: 700; border-radius: var(--radius-pill); padding: 2px var(--space-3); background: var(--color-bg-line-soft); }
.badge.active { background: var(--color-teal); color: var(--color-teal-deep); }
.badge.paused { background: var(--color-sun); color: var(--color-sun-ink); }
.empty { color: var(--color-ink-faint); text-align: center; padding: var(--space-6); }
.error { color: var(--color-coral-ink); }
</style>
