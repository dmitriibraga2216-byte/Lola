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
    <PageHeader :title="t('assign.title')" :crumbs="[{ label: t('admin.section.learning') }]">
      <template #actions>
        <NuxtLink to="/admin/assignments/new" class="btn primary">{{ t('assign.new') }}</NuxtLink>
      </template>
    </PageHeader>
    <div class="chips" role="tablist">
      <button v-for="k in (['all', 'manual', 'auto', 'catalog', 'trajectory', 'archived'] as const)" :key="k" role="tab" :aria-selected="tab === k" :class="['chip', { on: tab === k }]" @click="tab = k">
        {{ t(`assign.tab.${k}`) }}<template v-if="k === 'all' && items.length"> · {{ items.length }}</template>
      </button>
    </div>
    <p v-if="error" class="error-text">{{ error }}</p>
    <div class="table-wrap">
      <table class="table">
        <thead>
          <tr>
            <th>{{ t('assign.col.title') }}</th><th>{{ t('assign.col.kind') }}</th><th>{{ t('assign.col.author') }}</th>
            <th>{{ t('assign.col.created') }}</th><th>{{ t('assign.col.due') }}</th><th>{{ t('assign.col.people') }}</th><th>{{ t('assign.col.status') }}</th>
          </tr>
        </thead>
        <tbody>
          <tr v-for="r in items" :key="r.id" class="row" @click="navigateTo(`/admin/assignments/${r.id}`)">
            <td><b>{{ r.title }}</b><span v-if="r.isMandatory" class="sub">{{ t('assign.mandatory') }}</span></td>
            <td>{{ t(`assign.kind.${r.kind}`) }}</td>
            <td class="muted">{{ r.authorName || '—' }}</td>
            <td class="muted">{{ new Date(r.createdAt).toLocaleDateString('uk') }}</td>
            <td>{{ due(r) }}</td>
            <td class="num">{{ r.stats.assigned ?? 0 }}<span class="sub"><span class="teal">{{ r.stats.completed ?? 0 }}</span> · <span class="coral">{{ r.stats.overdue ?? 0 }}</span></span></td>
            <td><span :class="['badge upper', r.status]">{{ t(`assign.status.${r.status}`) }}</span></td>
          </tr>
          <tr v-if="items.length === 0"><td colspan="7" class="empty">{{ t('assign.empty') }}</td></tr>
        </tbody>
      </table>
    </div>
  </div>
</template>

<style scoped>
.chips { margin-bottom: var(--space-3); }
.row { cursor: pointer; }
.row:hover td { background: var(--color-bg-line-soft); }
.teal { color: var(--color-teal-ink); font-weight: 700; }
.coral { color: var(--color-coral-ink); font-weight: 700; }
.badge.active { background: var(--color-sun); color: var(--color-sun-ink); }
.badge.paused { background: var(--color-bg-line-soft); color: var(--color-ink-muted); }
.badge.archived { background: var(--color-bg-line-soft); color: var(--color-ink-muted); }
.empty { color: var(--color-ink-faint); text-align: center; padding: var(--space-6); }
</style>
