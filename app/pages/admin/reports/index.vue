<script setup lang="ts">
definePageMeta({ layout: 'admin', middleware: 'admin-scope', requiredScope: 'report.team' })

const { t } = useI18n()
const { api } = useApi()
const { hasScope } = useAuth()

type Report = 'readiness' | 'progress' | 'overdue' | 'attempts' | 'questions' | 'mentors' | 'content' | 'activity'
const report = ref<Report>('readiness')
const rows = ref<Record<string, unknown>[]>([])
const extra = ref<Record<string, unknown> | null>(null)
const drill = ref<{ location: string, position: string, people: Record<string, unknown>[] } | null>(null)
const error = ref('')
const loading = ref(false)
const filters = reactive({ from: '', to: '', locationId: '' })
const locations = ref<{ id: string, name: string }[]>([])

const reports: Report[] = ['readiness', 'progress', 'overdue', 'attempts', 'questions', 'mentors', 'content', 'activity']
const canSee = (r: Report) => (r === 'activity' || r === 'mentors') ? hasScope('report.tenant') : r === 'content' ? hasScope('course.view') : true
// Каркас (docs/22 §3): пресеты периода, плитки со сравнением, фоновая выгрузка
const preset = ref<'today' | '7d' | '30d' | 'quarter' | 'custom'>('30d')
const day = (d: Date) => d.toISOString().slice(0, 10)
function applyPreset(p: typeof preset.value) {
  preset.value = p
  const now = new Date()
  if (p === 'custom') return
  const from = p === 'today' ? now : new Date(now.getTime() - (p === '7d' ? 6 : p === '30d' ? 29 : 89) * 86_400_000)
  filters.from = day(from); filters.to = day(now)
  load()
}
const tiles = ref<Record<string, unknown> | null>(null)
const subject = ref<'course' | 'program' | 'quiz' | 'workshop' | 'meetup' | 'survey'>('course')
const funnel = ref<{ assigned: number, started: number, completed: number, passedFirst: number } | null>(null)
const contentRows = ref<Record<string, unknown>[]>([])
const attention = ref<{ id: string, title: string, reasons: string[] }[]>([])
const activityExtra = ref<{ dau: number, wau: number, mau: number, inactive_30: number, hours: { hour: number, opens: number }[] } | null>(null)
const exportNotice = ref('')
async function exportInBackground() {
  exportNotice.value = ''
  try {
    const query = Object.fromEntries(Object.entries(filters).filter(([, v]) => v))
    const r = await api<{ exportId: string }>(`/reports/${report.value}/export`, { method: 'POST', body: { filters: { ...query, subject: subject.value } } })
    exportNotice.value = t('reports.exportQueued', { id: r.exportId.slice(0, 8) })
  }
  catch (err) { error.value = apiErrorOf(err).message }
}
const tileDelta = (v: unknown) => { const d = (v as { delta?: number } | null)?.delta; return d == null ? '' : d > 0 ? `+${d}` : String(d) }
const tileVal = (v: unknown) => (typeof v === 'object' && v !== null && 'value' in v) ? (v as { value: number }).value : v

async function load() {
  loading.value = true
  error.value = ''
  drill.value = null
  try {
    const query = { ...Object.fromEntries(Object.entries(filters).filter(([, v]) => v)), tiles: 'true', ...(report.value === 'progress' ? { subject: subject.value } : {}) }
    const res = await api<{ data: unknown, tiles: Record<string, unknown> } | unknown>(`/reports/${report.value}`, { query })
    const data = (res && typeof res === 'object' && 'tiles' in (res as object)) ? (res as { data: unknown }).data : res
    tiles.value = (res && typeof res === 'object' && 'tiles' in (res as object)) ? (res as { tiles: Record<string, unknown> }).tiles : null
    funnel.value = null; contentRows.value = []; attention.value = []; activityExtra.value = null
    if (report.value === 'activity') {
      const d = data as { summary: Record<string, unknown>, daily: Record<string, unknown>[] }
      extra.value = d.summary
      rows.value = d.daily
      activityExtra.value = await api<typeof activityExtra.value>('/reports/activity-extra', { query }).catch(() => null)
    }
    else if (report.value === 'progress') {
      const d = data as { funnel: typeof funnel.value, rows: Record<string, unknown>[], content: Record<string, unknown>[] }
      extra.value = null; funnel.value = d.funnel; rows.value = d.rows; contentRows.value = d.content
    }
    else if (report.value === 'content') {
      const d = data as { rows: Record<string, unknown>[], attention: typeof attention.value }
      extra.value = null; rows.value = d.rows; attention.value = d.attention
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
watch(subject, () => { if (report.value === 'progress') load() })
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
      <div class="presets" role="group">
        <button v-for="p in (['today', '7d', '30d', 'quarter', 'custom'] as const)" :key="p" :class="['chip', { on: preset === p }]" @click="applyPreset(p)">{{ t(`reports.preset.${p}`) }}</button>
      </div>
      <label>{{ t('reports.from') }} <input v-model="filters.from" type="date" @change="preset = 'custom'; load()"></label>
      <label>{{ t('reports.to') }} <input v-model="filters.to" type="date" @change="preset = 'custom'; load()"></label>
      <label v-if="report === 'progress'">{{ t('reports.subject') }}
        <select v-model="subject"><option v-for="s in ['course', 'program', 'quiz', 'workshop', 'meetup', 'survey']" :key="s" :value="s">{{ t(`reports.subjects.${s}`) }}</option></select>
      </label>
      <label>{{ t('person.location') }}
        <select v-model="filters.locationId" @change="load">
          <option value="">{{ t('reports.allLocations') }}</option>
          <option v-for="l in locations" :key="l.id" :value="l.id">{{ l.name }}</option>
        </select>
      </label>
      <a v-if="hasScope('report.export') && report !== 'content'" :href="exportUrl" class="export">{{ t('reports.export') }}</a>
      <button v-if="hasScope('report.export')" class="chip" @click="exportInBackground">{{ t('reports.exportBg') }}</button>
      <NuxtLink to="/admin/reports/exports" class="chip">{{ t('reports.myExports') }}</NuxtLink>
    </div>
    <p v-if="exportNotice" class="notice" role="status">{{ exportNotice }}</p>

    <!-- Плитки со сравнением с прошлым периодом (docs/22 §3) -->
    <div v-if="tiles" class="kpis">
      <template v-for="(v, k) in tiles" :key="k">
        <div v-if="k !== 'period' && k !== 'previous'" class="kpi"><b>{{ tileVal(v) ?? 0 }}<small v-if="tileDelta(v)" :class="['delta', String(tileDelta(v)).startsWith('+') ? 'up' : 'down']"> {{ tileDelta(v) }}</small></b><span>{{ t(`reports.tile.${k}`) }}</span></div>
      </template>
    </div>
    <div v-if="funnel" class="funnel">
      <div v-for="k in (['assigned', 'started', 'completed', 'passedFirst'] as const)" :key="k" class="step"><b>{{ funnel[k] }}</b><span>{{ t(`reports.funnel.${k}`) }}</span><i :style="{ width: `${funnel.assigned ? funnel[k] / funnel.assigned * 100 : 0}%` }" /></div>
    </div>
    <section v-if="contentRows.length" class="card">
      <h2>{{ t('reports.worstContent') }}</h2>
      <table class="table"><thead><tr><th>{{ t('assign.col.title') }}</th><th>{{ t('reports.funnel.assigned') }}</th><th>{{ t('reports.funnel.completed') }}</th><th>%</th></tr></thead>
        <tbody><tr v-for="c in contentRows.slice(0, 10)" :key="String(c.subjectId)"><td>{{ c.title }}</td><td>{{ c.assigned }}</td><td>{{ c.completed }}</td><td :class="Number(c.completionPct) < 50 ? 'coral' : ''">{{ c.completionPct }}</td></tr></tbody></table>
    </section>
    <section v-if="attention.length" class="card">
      <h2>{{ t('reports.needsAttention') }}</h2>
      <ul class="list"><li v-for="a in attention" :key="a.id"><NuxtLink :to="`/admin/courses/${a.id}`" class="link">{{ a.title }}</NuxtLink> <span class="sub">{{ a.reasons.map(r => t(`reports.reason.${r}`)).join(' · ') }}</span></li></ul>
    </section>
    <div v-if="activityExtra" class="kpis">
      <div class="kpi"><b>{{ activityExtra.dau }}</b><span>DAU</span></div><div class="kpi"><b>{{ activityExtra.wau }}</b><span>WAU</span></div><div class="kpi"><b>{{ activityExtra.mau }}</b><span>MAU</span></div>
      <div class="kpi"><b>{{ activityExtra.inactive_30 }}</b><span>{{ t('reports.inactive30') }}</span></div>
    </div>
    <section v-if="activityExtra" class="card">
      <h2>{{ t('reports.byHour') }}</h2>
      <div class="hours"><div v-for="h in activityExtra.hours" :key="h.hour" class="hour" :title="`${h.hour}:00 — ${h.opens}`"><i :style="{ height: `${Math.max(2, h.opens / Math.max(1, ...activityExtra.hours.map(x => x.opens)) * 60)}px` }" /><span>{{ h.hour }}</span></div></div>
    </section>

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
.presets { display: flex; gap: var(--space-1); flex-wrap: wrap; }
.chip { font: inherit; font-size: var(--font-size-body-s); font-weight: 700; border: 1px solid var(--color-bg-line); background: transparent; color: var(--color-ink-muted); border-radius: var(--radius-pill); padding: var(--space-1) var(--space-3); cursor: pointer; text-decoration: none; }
.chip.on { background: var(--color-ink); color: var(--color-bg-soft); border-color: var(--color-ink); }
.delta { font-size: var(--font-size-body-s); font-weight: 700; }
.delta.up { color: var(--color-teal-ink); }
.delta.down { color: var(--color-coral-ink); }
.funnel { display: grid; grid-template-columns: repeat(auto-fit, minmax(140px, 1fr)); gap: var(--space-2); margin-bottom: var(--space-3); }
.step { background: var(--color-bg-soft); border-radius: var(--radius-m); padding: var(--space-3); display: grid; gap: 2px; position: relative; overflow: hidden; }
.step b { font-size: var(--font-size-title-l); font-weight: 900; }
.step span { font-size: var(--font-size-body-s); color: var(--color-ink-muted); }
.step i { position: absolute; left: 0; bottom: 0; height: 4px; background: var(--color-teal); }
.card { background: var(--color-bg-soft); border-radius: var(--radius-m); padding: var(--space-3); margin-bottom: var(--space-3); }
.card h2 { margin: 0 0 var(--space-2); font-size: var(--font-size-body); }
.list { list-style: none; margin: 0; padding: 0; display: grid; gap: var(--space-1); }
.hours { display: flex; gap: 2px; align-items: flex-end; height: 80px; }
.hour { flex: 1; display: grid; grid-template-rows: 1fr auto; align-items: end; text-align: center; font-size: 10px; color: var(--color-ink-faint); }
.hour i { display: block; background: var(--color-sun); border-radius: 2px 2px 0 0; }
.notice { color: var(--color-teal-ink); }
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
