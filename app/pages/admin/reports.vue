<script setup lang="ts">
definePageMeta({ layout: 'admin', middleware: 'admin-scope', requiredScope: 'report.team' })

const { t } = useI18n()
const { api } = useApi()
const { hasScope } = useAuth()

type Report = 'readiness' | 'overdue' | 'attempts' | 'activity' | 'mentors'
const report = ref<Report>('readiness')
const rows = ref<Record<string, unknown>[]>([])
const extra = ref<Record<string, unknown> | null>(null)
const drill = ref<{ location: string, position: string, people: Record<string, unknown>[] } | null>(null)
const error = ref('')
const loading = ref(false)
const filters = reactive({ from: '', to: '', locationId: '' })
const locations = ref<{ id: string, name: string }[]>([])

const reports: Report[] = ['readiness', 'overdue', 'attempts', 'activity', 'mentors']
const canSee = (r: Report) => (r === 'activity' || r === 'mentors') ? hasScope('report.tenant') : true

async function load() {
  loading.value = true
  error.value = ''
  drill.value = null
  try {
    const query = Object.fromEntries(Object.entries(filters).filter(([, v]) => v))
    const data = await api<unknown>(`/reports/${report.value}`, { query })
    if (report.value === 'activity') {
      const d = data as { summary: Record<string, unknown>, daily: Record<string, unknown>[] }
      extra.value = d.summary
      rows.value = d.daily
    }
    else {
      extra.value = null
      rows.value = data as Record<string, unknown>[]
    }
  }
  catch (err) {
    error.value = apiErrorOf(err).message
  }
  finally {
    loading.value = false
  }
}
watch(report, load)
onMounted(async () => {
  locations.value = await api<{ id: string, name: string }[]>('/refs/locations').catch(() => [])
  await load()
})

// Готовность: матрица точки × позиции
const matrix = computed(() => {
  if (report.value !== 'readiness') return null
  const locs = [...new Set(rows.value.map(r => String(r.location)))]
  const poss = [...new Set(rows.value.map(r => String(r.position)))]
  return { locs, poss, cell: (l: string, p: string) => rows.value.find(r => r.location === l && r.position === p) }
})

async function drillInto(cell: Record<string, unknown>) {
  const people = await api<Record<string, unknown>[]>('/reports/readiness-people', { query: { locationId: cell.location_id, positionId: cell.position_id } })
  drill.value = { location: String(cell.location), position: String(cell.position), people }
}

const exportUrl = computed(() => {
  const q = new URLSearchParams({ format: 'xlsx', ...Object.fromEntries(Object.entries(filters).filter(([, v]) => v)) })
  return `/api/v1/reports/${report.value}?${q}`
})

const columns = computed(() => rows.value[0] ? Object.keys(rows.value[0]).filter(k => !k.endsWith('_id') && k !== 'id') : [])
const fmtCell = (v: unknown) => v === null || v === undefined ? '—' : typeof v === 'string' && /^\d{4}-\d{2}-\d{2}T/.test(v) ? new Date(v).toLocaleDateString('uk') : typeof v === 'boolean' ? (v ? '✓' : '✕') : String(v)
</script>

<template>
  <div>
    <h1>{{ t('admin.nav.reports') }}</h1>
    <div class="tabs">
      <button v-for="r in reports.filter(canSee)" :key="r" :class="['tab', { on: report === r }]" @click="report = r">{{ t(`reports.${r}`) }}</button>
    </div>

    <div class="filters">
      <label>{{ t('reports.from') }} <input v-model="filters.from" type="date" @change="load"></label>
      <label>{{ t('reports.to') }} <input v-model="filters.to" type="date" @change="load"></label>
      <label>{{ t('person.location') }}
        <select v-model="filters.locationId" @change="load">
          <option value="">{{ t('reports.allLocations') }}</option>
          <option v-for="l in locations" :key="l.id" :value="l.id">{{ l.name }}</option>
        </select>
      </label>
      <a v-if="hasScope('report.export')" :href="exportUrl" class="export">{{ t('reports.export') }}</a>
    </div>

    <p v-if="error" class="error">{{ error }}</p>
    <div v-if="loading" class="empty">{{ t('common.loading') }}</div>

    <!-- KPI активности -->
    <div v-if="extra" class="kpis">
      <div v-for="(v, k) in extra" :key="k" class="kpi"><b>{{ v ?? 0 }}</b><span>{{ t(`reports.kpi.${k}`) }}</span></div>
    </div>

    <!-- Готовность: матрица -->
    <div v-if="matrix && !loading" class="matrix-wrap">
      <table class="matrix">
        <thead><tr><th /><th v-for="p in matrix.poss" :key="p">{{ p }}</th></tr></thead>
        <tbody>
          <tr v-for="l in matrix.locs" :key="l">
            <th>{{ l }}</th>
            <td v-for="p in matrix.poss" :key="p">
              <button v-if="matrix.cell(l, p)" :class="['cell', Number(matrix.cell(l, p)!.pct) >= 80 ? 'ok' : 'low']" @click="drillInto(matrix.cell(l, p)!)">
                <b>{{ matrix.cell(l, p)!.pct }}%</b>
                <span>{{ matrix.cell(l, p)!.ready }}/{{ matrix.cell(l, p)!.people }}</span>
              </button>
              <span v-else class="sub">—</span>
            </td>
          </tr>
        </tbody>
      </table>
      <p v-if="rows.length === 0" class="empty">{{ t('reports.noData') }}</p>

      <div v-if="drill" class="drill">
        <h2>{{ drill.location }} · {{ drill.position }}</h2>
        <table class="table">
          <thead><tr><th>{{ t('people.col.name') }}</th><th>{{ t('reports.mandatory') }}</th><th>{{ t('reports.done') }}</th><th>{{ t('reports.overdueCol') }}</th></tr></thead>
          <tbody>
            <tr v-for="p in drill.people" :key="String(p.id)">
              <td><NuxtLink :to="`/admin/people/${p.id}`" class="link">{{ p.full_name }}</NuxtLink></td>
              <td>{{ p.mandatory }}</td>
              <td class="teal">{{ p.done }}</td>
              <td :class="{ coral: Number(p.overdue) > 0 }">{{ p.overdue }}</td>
            </tr>
          </tbody>
        </table>
      </div>
    </div>

    <!-- Остальные — таблица -->
    <table v-else-if="!loading && rows.length" class="table">
      <thead><tr><th v-for="c in columns" :key="c">{{ t(`reports.col.${c}`, c) }}</th></tr></thead>
      <tbody>
        <tr v-for="(r, i) in rows" :key="i">
          <td v-for="c in columns" :key="c">{{ fmtCell(r[c]) }}</td>
        </tr>
      </tbody>
    </table>
    <p v-else-if="!loading && !matrix" class="empty">{{ t('reports.noData') }}</p>
  </div>
</template>

<style scoped>
h1 { margin: 0 0 var(--space-4); font-weight: 900; }
h2 { margin: var(--space-4) 0 var(--space-2); font-weight: 800; font-size: var(--font-size-title-l); }
.tabs { display: flex; gap: var(--space-2); margin-bottom: var(--space-4); flex-wrap: wrap; }
.tab { font: inherit; font-weight: 700; border: 1px solid var(--color-bg-line); background: transparent; color: var(--color-ink-muted); border-radius: var(--radius-pill); padding: var(--space-1) var(--space-4); cursor: pointer; }
.tab.on { background: var(--color-ink); border-color: var(--color-ink); color: var(--color-bg-soft); }
.filters { display: flex; gap: var(--space-3); align-items: end; flex-wrap: wrap; margin-bottom: var(--space-4); }
.filters label { display: grid; gap: var(--space-1); font-size: var(--font-size-body-s); color: var(--color-ink-muted); }
input, select { font: inherit; border: 1px solid var(--color-bg-line); border-radius: var(--radius-s); padding: var(--space-1) var(--space-3); background: var(--color-bg-soft); color: var(--color-ink); }
.export { margin-left: auto; font-weight: 800; background: var(--color-sun); color: var(--color-ink); border-radius: var(--radius-pill); padding: var(--space-2) var(--space-4); text-decoration: none; }
.kpis { display: flex; gap: var(--space-3); flex-wrap: wrap; margin-bottom: var(--space-4); }
.kpi { background: var(--color-bg-soft); border-radius: var(--radius-m); padding: var(--space-3) var(--space-4); display: grid; text-align: center; min-width: 110px; }
.kpi b { font-size: var(--font-size-title-l); font-weight: 900; color: var(--color-teal-ink); }
.kpi span { font-size: var(--font-size-body-s); color: var(--color-ink-muted); }
.matrix-wrap { display: grid; gap: var(--space-4); }
.matrix { border-collapse: separate; border-spacing: var(--space-1); }
.matrix th { font-size: var(--font-size-body-s); color: var(--color-ink-muted); text-align: left; padding: var(--space-1) var(--space-2); font-weight: 700; }
.cell { font: inherit; border: none; border-radius: var(--radius-s); padding: var(--space-2) var(--space-3); display: grid; cursor: pointer; min-width: 80px; }
.cell b { font-weight: 900; }
.cell span { font-size: var(--font-size-body-s); opacity: 0.8; }
.cell.ok { background: var(--color-teal); color: var(--color-teal-deep); }
.cell.low { background: var(--color-sun); color: var(--color-sun-ink); }
.drill { background: var(--color-bg-soft); border-radius: var(--radius-m); padding: var(--space-4); }
.table { width: 100%; border-collapse: collapse; background: var(--color-bg-soft); border-radius: var(--radius-m); overflow: hidden; }
.table th { text-align: left; font-size: var(--font-size-body-s); color: var(--color-ink-muted); padding: var(--space-2) var(--space-3); border-bottom: 1px solid var(--color-bg-line); }
.table td { padding: var(--space-2) var(--space-3); border-bottom: 1px solid var(--color-bg-line-soft); }
.link { color: var(--color-ink); font-weight: 700; text-decoration: none; }
.teal { color: var(--color-teal-ink); font-weight: 700; }
.coral { color: var(--color-coral-ink); font-weight: 700; }
.sub { color: var(--color-ink-faint); }
.empty { color: var(--color-ink-faint); padding: var(--space-6); text-align: center; }
.error { color: var(--color-coral-ink); }
</style>
