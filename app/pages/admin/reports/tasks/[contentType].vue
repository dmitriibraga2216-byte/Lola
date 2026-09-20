<script setup lang="ts">
definePageMeta({ layout: 'admin', middleware: 'admin-scope', requiredScope: 'report.team' })

/**
 * Отчёт по типу контента (docs/22 §13.2, §13.7; мокап ReportTest): один экран на тип, назначение — фильтром.
 * Четыре части: «Огляд успішності» (пять плиток) · «Звернення до тесту по тижнях» · «Статистика» из шести строк ·
 * таблица людей с единым каркасом (ReportFrame) и правой частью по типу. У теста рядом с результатом — «Перерахувати».
 */
const { t } = useI18n()
const route = useRoute()
const router = useRouter()
const { api } = useApi()
const { hasScope } = useAuth()

type CT = 'course' | 'training_program' | 'test'
type Row = Record<string, unknown> & { user_id: string, status: string | null, result: number | null, last_attempt_id?: string | null, best_pct?: number | null, attempts_used?: number, attempts_allowed?: number | null, last_attempt_at?: string | null, progress_pct?: number | null, due_at?: string | null, overdue?: boolean, context?: string, context_title?: string | null }
interface Report {
  contentType: CT
  subject: { id: string, title: string } | null
  task: { id: string, title: string, attemptsAllowed: number | null } | null
  overview: { assigned: number, notStarted: number, inProgress: number, failed: number, done: number, donePct: number }
  accesses: { day: string, hits: number, users: number }[]
  stats: { assigned: number, doneOk: number, notOpened: number, doneFail: number, inProgress: number, onReview: number }
  rows: Row[]
}
const SUPPORTED: CT[] = ['course', 'training_program', 'test']
const contentType = computed(() => String(route.params.contentType) as CT)
const supported = computed(() => SUPPORTED.includes(contentType.value))
const tasks = ref<{ id: string, title: string, assigned: number }[]>([])
const locations = ref<{ id: string, name: string }[]>([])
const report = ref<Report | null>(null)
const error = ref('')
const notice = ref('')
const loading = ref(false)
const filters = reactive({ taskId: String(route.query.taskId ?? ''), from: '', to: '', locationId: '', context: 'any', status: '' })
const CONTEXTS = ['any', 'standalone', 'in_course', 'in_program']
const STATUSES = ['not_started', 'in_progress', 'done', 'failed']
const preset = ref<'all' | '7d' | '30d' | 'quarter'>('all')
const day = (d: Date) => d.toISOString().slice(0, 10)
function applyPreset(p: typeof preset.value) {
  preset.value = p
  if (p === 'all') { filters.from = ''; filters.to = ''; return }
  const now = new Date()
  filters.from = day(new Date(now.getTime() - (p === '7d' ? 6 : p === '30d' ? 29 : 89) * 86_400_000)); filters.to = day(now)
}

const query = () => Object.fromEntries(Object.entries(filters).filter(([k, v]) => v && !(k === 'context' && v === 'any')))
async function load() {
  if (!supported.value) return
  loading.value = true; error.value = ''
  try {
    if (!filters.taskId) { report.value = null; return }
    report.value = await api<Report>(`/reports/tasks/${contentType.value}`, { query: query() })
    router.replace({ query: { ...route.query, taskId: filters.taskId } })
  }
  catch (err) { error.value = apiErrorOf(err).message; report.value = null }
  finally { loading.value = false }
}
watch(filters, load)
onMounted(async () => {
  locations.value = await api<{ id: string, name: string }[]>('/refs/locations').catch(() => [])
  const r = await api<{ rows: { id: string, title: string, assigned: number }[] }>('/reports/summary', { method: 'POST', body: { step: 'tasks', taskFilter: { contentTypes: [contentType.value] }, limit: 200 } }).catch(() => ({ rows: [] }))
  tasks.value = r.rows
  await load()
})

// Часть 2: обращения по неделям — две серии, каждая подписана числом (docs/22 §3: максимум два цвета, сеток нет)
const weeks = computed(() => {
  const acc = new Map<string, { label: string, hits: number, users: number }>()
  for (const a of report.value?.accesses ?? []) {
    const d = new Date(a.day); const monday = new Date(d); monday.setDate(d.getDate() - ((d.getDay() + 6) % 7))
    const key = day(monday)
    const w = acc.get(key) ?? { label: monday.toLocaleDateString('uk', { day: '2-digit', month: '2-digit' }), hits: 0, users: 0 }
    w.hits += a.hits; w.users = Math.max(w.users, a.users)
    acc.set(key, w)
  }
  return [...acc.entries()].sort(([a], [b]) => a.localeCompare(b)).map(([, w]) => w).slice(-10)
})
const maxWeek = computed(() => Math.max(1, ...weeks.value.map(w => w.hits)))

const recalculating = ref<string | null>(null)
async function recalc(row: Row) {
  if (!row.last_attempt_id) return
  recalculating.value = row.user_id; notice.value = ''
  try {
    const r = await api<{ changed: boolean }>(`/attempts/${row.last_attempt_id}/recalculate`, { method: 'POST', body: {} })
    notice.value = r.changed ? t('taskReport.recalcChanged') : t('taskReport.recalcSame')
    await load()
  }
  catch (err) { error.value = apiErrorOf(err).message }
  finally { recalculating.value = null }
}
async function recalcAll() {
  if (!report.value?.subject) return
  recalculating.value = 'all'; notice.value = ''
  try {
    const r = await api<{ total: number, changed: number }>(`/tests/${report.value.subject.id}/recalculate`, { method: 'POST', body: {} })
    notice.value = t('taskReport.recalcAllDone', { total: r.total, changed: r.changed })
    await load()
  }
  catch (err) { error.value = apiErrorOf(err).message }
  finally { recalculating.value = null }
}
const dateOf = (v: unknown) => v ? new Date(String(v).replace(' ', 'T').replace(/([+-]\d{2})$/, '$1:00')).toLocaleDateString('uk', { day: '2-digit', month: '2-digit', year: 'numeric' }) : '—'
const exportUrl = computed(() => `/api/v1/reports/tasks/${contentType.value}?${new URLSearchParams({ ...query(), format: 'xlsx' })}`)
const title = computed(() => report.value?.task?.title ?? report.value?.subject?.title ?? t('taskReport.pick', { type: t(`contentType.${contentType.value}`).toLowerCase() }))
</script>

<template>
  <div>
    <PageHeader :title="title" :crumbs="[{ label: t('admin.nav.reports'), to: '/admin/reports' }, { label: t(`contentType.${contentType}`) }]">
      <template #actions>
        <button v-if="contentType === 'test' && report?.subject && hasScope('question.manage')" class="btn ghost" :disabled="recalculating === 'all'" @click="recalcAll">{{ t('taskReport.recalcAll') }}</button>
        <a v-if="report && hasScope('report.export')" :href="exportUrl" class="btn ghost" download>{{ t('taskReport.exportXlsx') }}</a>
      </template>
    </PageHeader>

    <p v-if="!supported" class="note sun">{{ t('taskReport.unsupported') }}</p>
    <template v-else>
      <div class="filters">
        <label class="field">{{ t('taskReport.task') }}
          <select v-model="filters.taskId">
            <option value="">{{ t('taskReport.pickShort') }}</option>
            <option v-for="task in tasks" :key="task.id" :value="task.id">{{ task.title }} · {{ task.assigned }}</option>
          </select>
        </label>
        <div class="chips" role="group" :aria-label="t('taskReport.preset.label')">
          <button v-for="p in (['all', '7d', '30d', 'quarter'] as const)" :key="p" :class="['chip', { on: preset === p }]" @click="applyPreset(p)">{{ t(`taskReport.preset.${p}`) }}</button>
        </div>
        <label class="field">{{ t('reports.from') }} <input v-model="filters.from" type="date" @input="preset = 'all'"></label>
        <label class="field">{{ t('reports.to') }} <input v-model="filters.to" type="date" @input="preset = 'all'"></label>
        <label class="field">{{ t('reports.col.location') }}
          <select v-model="filters.locationId"><option value="">{{ t('reports.allLocations') }}</option><option v-for="l in locations" :key="l.id" :value="l.id">{{ l.name }}</option></select>
        </label>
        <label class="field">{{ t('frame.context.label') }}
          <select v-model="filters.context"><option v-for="c in CONTEXTS" :key="c" :value="c">{{ t(`frame.context.${c}`) }}</option></select>
        </label>
        <label class="field">{{ t('frame.col.status') }}
          <select v-model="filters.status"><option value="">{{ t('taskReport.anyStatus') }}</option><option v-for="s in STATUSES" :key="s" :value="s">{{ t(`enrollment.${s}`) }}</option></select>
        </label>
      </div>

      <p v-if="error" class="error-text" role="alert">{{ error }}</p>
      <p v-if="notice" class="note sun" role="status">{{ notice }}</p>
      <p v-if="!filters.taskId" class="muted">{{ t('taskReport.pickHint') }}</p>

      <template v-if="report">
        <!-- 1. Огляд успішності -->
        <section class="tiles part" :aria-label="t('taskReport.overview')">
          <div class="tile"><b>{{ report.overview.assigned }}</b><span>{{ t('taskReport.tile.assigned') }}</span></div>
          <div class="tile"><b>{{ report.overview.notStarted }}</b><span>{{ t('taskReport.tile.notStarted') }}</span></div>
          <div class="tile"><b>{{ report.overview.inProgress }}</b><span>{{ t('taskReport.tile.inProgress') }}</span></div>
          <div class="tile coral"><b>{{ report.overview.failed }}</b><span>{{ t('taskReport.tile.failed') }}</span></div>
          <div class="tile teal"><b>{{ report.overview.done }}</b><span>{{ t('taskReport.tile.done') }} · {{ report.overview.donePct }}%</span></div>
        </section>

        <div class="two part">
          <!-- 2. Звернення по тижнях -->
          <section class="card chart" :aria-label="t('taskReport.accesses')">
            <h2 class="panel-title">{{ t('taskReport.accesses') }}</h2>
            <p v-if="!weeks.length" class="muted">{{ t('reports.noData') }}</p>
            <div v-else class="bars" role="img" :aria-label="t('taskReport.accessesAria')">
              <div v-for="w in weeks" :key="w.label" class="week">
                <div class="pair">
                  <div class="bar hits" :style="{ height: `${Math.max(4, Math.round(w.hits / maxWeek * 100))}px` }" :title="`${t('taskReport.hits')}: ${w.hits}`"><i>{{ w.hits }}</i></div>
                  <div class="bar users" :style="{ height: `${Math.max(4, Math.round(w.users / maxWeek * 100))}px` }" :title="`${t('taskReport.users')}: ${w.users}`"><i>{{ w.users }}</i></div>
                </div>
                <span class="wl">{{ w.label }}</span>
              </div>
            </div>
            <div class="legend"><span><i class="sw hits" />{{ t('taskReport.hits') }}</span><span><i class="sw users" />{{ t('taskReport.users') }}</span></div>
          </section>
          <!-- 3. Статистика -->
          <section class="card" :aria-label="t('taskReport.stats')">
            <h2 class="panel-title">{{ t('taskReport.stats') }}</h2>
            <dl class="stats">
              <div><dt>{{ t('taskReport.stat.assigned') }}</dt><dd>{{ report.stats.assigned }}</dd></div>
              <div><dt>{{ t('taskReport.stat.doneOk') }}</dt><dd>{{ report.stats.doneOk }}</dd></div>
              <div><dt>{{ t('taskReport.stat.notOpened') }}</dt><dd>{{ report.stats.notOpened }}</dd></div>
              <div><dt>{{ t('taskReport.stat.doneFail') }}</dt><dd>{{ report.stats.doneFail }}</dd></div>
              <div><dt>{{ t('taskReport.stat.inProgress') }}</dt><dd>{{ report.stats.inProgress }}</dd></div>
              <div><dt>{{ t('taskReport.stat.onReview') }}</dt><dd>{{ report.stats.onReview }}</dd></div>
            </dl>
          </section>
        </div>

        <!-- 4. Таблица людей: единый каркас + правая часть по типу -->
        <div class="table-wrap part">
          <table v-if="report.rows.length" class="table">
            <thead>
              <tr>
                <ReportFrame part="head" />
                <template v-if="contentType === 'test'">
                  <th>{{ t('taskReport.col.lastAttempt') }}</th>
                  <th class="num">{{ t('taskReport.col.best') }}</th>
                  <th class="num">{{ t('taskReport.col.attemptsUsed') }}</th>
                  <th class="num">{{ t('taskReport.col.attemptsAllowed') }}</th>
                  <th />
                </template>
                <template v-else>
                  <th class="num">{{ t('taskReport.col.progress') }}</th>
                  <th>{{ t('taskReport.col.due') }}</th>
                  <th>{{ t('frame.context.label') }}</th>
                </template>
              </tr>
            </thead>
            <tbody>
              <tr v-for="r in report.rows" :key="r.user_id">
                <ReportFrame part="cells" :row="r" />
                <template v-if="contentType === 'test'">
                  <td>{{ dateOf(r.last_attempt_at) }}</td>
                  <td class="num">{{ r.best_pct == null ? '—' : `${r.best_pct}%` }}</td>
                  <td class="num">{{ r.attempts_used ?? 0 }}</td>
                  <td class="num">{{ r.attempts_allowed ? r.attempts_allowed : '∞' }}</td>
                  <td><button v-if="r.last_attempt_id && hasScope('question.manage')" class="btn ghost small" :disabled="recalculating === r.user_id" @click="recalc(r)">{{ t('taskReport.recalc') }}</button></td>
                </template>
                <template v-else>
                  <td class="num">{{ r.progress_pct ?? 0 }}%</td>
                  <td>{{ dateOf(r.due_at) }}<span v-if="r.overdue" class="badge coral">{{ t('enrollment.overdue') }}</span></td>
                  <td>{{ t(`frame.context.${r.context ?? 'standalone'}`) }}<span v-if="r.context_title" class="sub">{{ r.context_title }}</span></td>
                </template>
              </tr>
            </tbody>
          </table>
          <p v-else class="muted">{{ t('reports.noData') }}</p>
        </div>
      </template>
    </template>
  </div>
</template>

<style scoped>
.filters { display: flex; gap: var(--space-3); align-items: end; flex-wrap: wrap; margin: var(--space-2) 0 var(--space-4); }
.field { display: grid; gap: var(--space-1); font-size: var(--font-size-body-s); color: var(--color-ink-muted); font-weight: 700; }
select, input { font: inherit; border: 1px solid var(--color-bg-line); border-radius: var(--radius-s); padding: var(--space-2) var(--space-3); background: var(--color-bg-soft); color: var(--color-ink); max-width: 100%; }
.part { margin-bottom: var(--space-4); }
.two { display: grid; grid-template-columns: 1fr; gap: var(--space-3); }
@media (min-width: 900px) { .two { grid-template-columns: 1.4fr 1fr; } }
.bars { display: flex; gap: var(--space-2); align-items: flex-end; overflow-x: auto; padding-top: var(--space-4); }
.week { flex: 1 0 44px; display: flex; flex-direction: column; align-items: center; gap: var(--space-1); }
.pair { display: flex; gap: 3px; align-items: flex-end; height: 120px; }
.bar { width: 16px; border-radius: var(--radius-s) var(--radius-s) 0 0; position: relative; }
.bar i { position: absolute; top: -18px; left: 50%; transform: translateX(-50%); font-style: normal; font-size: 11px; font-weight: 800; color: var(--color-ink-muted); }
.bar.hits, .sw.hits { background: var(--color-teal); }
.bar.users, .sw.users { background: var(--color-ink); }
.wl { font-size: 11px; font-weight: 700; color: var(--color-ink-muted); }
.legend { display: flex; gap: var(--space-4); margin-top: var(--space-3); font-size: var(--font-size-body-s); color: var(--color-ink-muted); font-weight: 700; }
.legend span { display: inline-flex; align-items: center; gap: var(--space-2); }
.sw { display: inline-block; width: 12px; height: 12px; border-radius: 3px; }
.stats { margin: 0; display: grid; gap: 0; }
.stats div { display: flex; justify-content: space-between; gap: var(--space-3); padding: var(--space-2) 0; border-bottom: 1px solid var(--color-bg-line-soft); }
.stats dt { font-weight: 600; }
.stats dd { margin: 0; font-family: ui-monospace, monospace; font-weight: 900; }
.num { text-align: right; font-variant-numeric: tabular-nums; }
.sub { display: block; font-size: var(--font-size-body-s); color: var(--color-ink-faint); }
.badge.coral { margin-left: var(--space-2); }
</style>
