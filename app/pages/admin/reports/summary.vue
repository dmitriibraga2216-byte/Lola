<script setup lang="ts">
const { formatShortDate } = useFormat()
definePageMeta({ layout: 'admin', middleware: 'admin-scope', requiredScope: 'report.team' })

/**
 * Зведений звіт — мастер (docs/22 §13.1; мокап SummaryReport): 1 Користувачі → 2 Завдання → 3 Конфігурація → 4 Результат.
 * Отчёт строится пересечением двух выборок, а не «по курсу». Каждый шаг считается на сервере (`POST /reports/summary`),
 * справа — «Вибірка: людей N · завдань N». Таблица результата — единый каркас (ReportFrame) плюс колонка на задание.
 */
const { t } = useI18n()
const { api } = useApi()
const { hasScope } = useAuth()

type Row = Record<string, unknown> & { user_id: string, status?: string | null, tasks?: Record<string, { status: string, result?: number | null }> }
const step = ref<1 | 2 | 3 | 4>(1)
const userFilter = reactive({ q: '', locationIds: [] as string[], positionIds: [] as string[], tags: '' as string, includeArchived: false })
const taskFilter = reactive({ q: '', contentTypes: [] as string[] })
const selectedTasks = ref<string[]>([])
const columns = ref<string[]>(['status', 'result'])
const groupBy = ref<'none' | 'location' | 'position' | 'unit' | 'task'>('none')
const COLUMNS = ['status', 'result', 'assigned_at', 'completed_at', 'due_at', 'attempts']
const GROUPS = ['none', 'location', 'position', 'unit', 'task']
const CONTENT_TYPES = ['course', 'training_program', 'test', 'resource', 'workshop', 'poll', 'assessment', 'check_list', 'meetup', 'webinar', 'complex_test']

const locations = ref<{ id: string, name: string }[]>([])
const positions = ref<{ id: string, name: string }[]>([])
const users = ref<{ count: number, rows: Row[] }>({ count: 0, rows: [] })
const tasks = ref<{ id: string, title: string, content_type: string, assigned: number, created_at: string }[]>([])
const result = ref<{ people: number, tasks: { id: string, title: string, contentType: string }[], rows: Row[], groups: { key: string, label: string, total: number, done: number, inProgress: number, failed: number, notStarted: number, notAssigned: number }[] } | null>(null)
const error = ref('')
const notice = ref('')
const loading = ref(false)

const uf = () => ({ q: userFilter.q || undefined, locationIds: userFilter.locationIds.length ? userFilter.locationIds : undefined, positionIds: userFilter.positionIds.length ? userFilter.positionIds : undefined, tags: userFilter.tags ? userFilter.tags.split(',').map(s => s.trim()).filter(Boolean) : undefined, includeArchived: userFilter.includeArchived || undefined })
const tf = () => ({ q: taskFilter.q || undefined, contentTypes: taskFilter.contentTypes.length ? taskFilter.contentTypes : undefined })
const body = (extra: Record<string, unknown>) => ({ userFilter: uf(), taskFilter: { ...tf(), assignmentIds: selectedTasks.value.length ? selectedTasks.value : undefined }, columns: columns.value, groupBy: groupBy.value, ...extra })

async function run<T>(fn: () => Promise<T>) {
  loading.value = true; error.value = ''
  try { return await fn() }
  catch (err) { error.value = apiErrorOf(err).message }
  finally { loading.value = false }
}
const loadUsers = () => run(async () => { users.value = await api<{ count: number, rows: Row[] }>('/reports/summary', { method: 'POST', body: { step: 'users', userFilter: uf(), limit: 50 } }) })
const loadTasks = () => run(async () => { tasks.value = (await api<{ rows: typeof tasks.value }>('/reports/summary', { method: 'POST', body: { step: 'tasks', taskFilter: tf(), limit: 200 } })).rows })
const loadResult = () => run(async () => { result.value = await api<typeof result.value>('/reports/summary', { method: 'POST', body: body({ step: 'result' }) }) })

let timer: ReturnType<typeof setTimeout>
watch(userFilter, () => { clearTimeout(timer); timer = setTimeout(loadUsers, 300) })
watch(taskFilter, () => { clearTimeout(timer); timer = setTimeout(loadTasks, 300) })
onMounted(async () => {
  locations.value = await api<{ id: string, name: string }[]>('/refs/locations').catch(() => [])
  positions.value = await api<{ id: string, name: string }[]>('/refs/positions').catch(() => [])
  await loadUsers()
})
function go(to: 1 | 2 | 3 | 4) {
  step.value = to
  if (to === 2 && !tasks.value.length) loadTasks()
  if (to === 4) loadResult()
}
function reset() {
  Object.assign(userFilter, { q: '', locationIds: [], positionIds: [], tags: '', includeArchived: false })
  Object.assign(taskFilter, { q: '', contentTypes: [] })
  selectedTasks.value = []; columns.value = ['status', 'result']; groupBy.value = 'none'; result.value = null; step.value = 1
}
function toggleTask(id: string) { selectedTasks.value = selectedTasks.value.includes(id) ? selectedTasks.value.filter(x => x !== id) : [...selectedTasks.value, id] }
function toggleColumn(c: string) { columns.value = columns.value.includes(c) ? columns.value.filter(x => x !== c) : [...columns.value, c] }
async function exportInBackground() {
  await run(async () => {
    const r = await api<{ exportId: string }>('/reports/summary/export', { method: 'POST', body: { filters: body({}) } })
    notice.value = t('reports.exportQueued', { id: r.exportId.slice(0, 8) })
  })
}
const cell = (r: Row, taskId: string) => r.tasks?.[taskId] ?? { status: 'not_assigned' }
</script>

<template>
  <div>
    <PageHeader :title="t('summary.title')" :crumbs="[{ label: t('admin.nav.reports'), to: '/admin/reports' }, { label: t('summary.crumb') }]">
      <template #actions>
        <button class="btn ghost" @click="reset">{{ t('summary.reset') }}</button>
      </template>
    </PageHeader>

    <ol class="steps" :aria-label="t('summary.stepsAria')">
      <li v-for="(s, i) in (['users', 'tasks', 'config', 'result'] as const)" :key="s">
        <button :class="['step', { on: step === i + 1, done: step > i + 1 }]" :aria-current="step === i + 1 ? 'step' : undefined" @click="go((i + 1) as 1 | 2 | 3 | 4)"><b>{{ i + 1 }}</b> {{ t(`summary.step.${s}`) }}</button>
      </li>
    </ol>

    <p v-if="error" class="error-text" role="alert">{{ error }}</p>
    <p v-if="notice" class="note sun" role="status">{{ notice }}</p>

    <div class="layout">
      <section class="main">
        <!-- 1. Користувачі: тот же фильтруемый список людей, что и в назначении -->
        <template v-if="step === 1">
          <div class="filters">
            <label class="field">{{ t('summary.search') }} <input v-model="userFilter.q" type="search" :placeholder="t('orgAdmin.searchPerson')"></label>
            <label class="field">{{ t('reports.col.location') }}
              <select v-model="userFilter.locationIds" multiple size="4"><option v-for="l in locations" :key="l.id" :value="l.id">{{ l.name }}</option></select>
            </label>
            <label class="field">{{ t('frame.col.position') }}
              <select v-model="userFilter.positionIds" multiple size="4"><option v-for="p in positions" :key="p.id" :value="p.id">{{ p.name }}</option></select>
            </label>
            <label class="field">{{ t('frame.col.tags') }} <input v-model="userFilter.tags" :placeholder="t('summary.tagsHint')"></label>
            <label class="toggle"><input v-model="userFilter.includeArchived" type="checkbox">{{ t('summary.includeArchived') }}</label>
          </div>
          <p class="count">{{ t('summary.usersCount', { n: users.count }) }}</p>
          <div class="table-wrap">
            <table v-if="users.rows.length" class="table">
              <thead><tr><ReportFrame part="head" :tail="false" /><th>{{ t('summary.col.registered') }}</th></tr></thead>
              <tbody><tr v-for="r in users.rows" :key="r.user_id"><ReportFrame part="cells" :row="r" :tail="false" /><td>{{ formatShortDate(new Date(String(r.registered_at))) }}</td></tr></tbody>
            </table>
            <p v-else class="muted">{{ t('reports.noData') }}</p>
          </div>
        </template>

        <!-- 2. Завдання -->
        <template v-else-if="step === 2">
          <div class="filters">
            <label class="field">{{ t('summary.search') }} <input v-model="taskFilter.q" type="search"></label>
            <div class="chips" role="group" :aria-label="t('summary.col.type')">
              <button v-for="ct in CONTENT_TYPES" :key="ct" :class="['chip', { on: taskFilter.contentTypes.includes(ct) }]" :aria-pressed="taskFilter.contentTypes.includes(ct)" @click="taskFilter.contentTypes = taskFilter.contentTypes.includes(ct) ? taskFilter.contentTypes.filter(x => x !== ct) : [...taskFilter.contentTypes, ct]">{{ t(`contentType.${ct}`) }}</button>
            </div>
          </div>
          <div class="table-wrap">
            <table v-if="tasks.length" class="table">
              <thead><tr><th>{{ t('summary.col.task') }}</th><th>{{ t('summary.col.type') }}</th><th class="num">{{ t('summary.col.assigned') }}</th><th>{{ t('summary.col.pick') }}</th></tr></thead>
              <tbody>
                <tr v-for="task in tasks" :key="task.id">
                  <td><strong>{{ task.title }}</strong></td>
                  <td>{{ t(`contentType.${task.content_type}`) }}</td>
                  <td class="num">{{ task.assigned }}</td>
                  <td><label class="toggle"><input type="checkbox" :checked="selectedTasks.includes(task.id)" :aria-label="task.title" @change="toggleTask(task.id)"></label></td>
                </tr>
              </tbody>
            </table>
            <p v-else class="muted">{{ t('reports.noData') }}</p>
          </div>
        </template>

        <!-- 3. Конфігурація -->
        <template v-else-if="step === 3">
          <div class="config">
            <fieldset class="card">
              <legend class="panel-title">{{ t('summary.columns') }}</legend>
              <label v-for="c in COLUMNS" :key="c" class="toggle row"><input type="checkbox" :checked="columns.includes(c)" @change="toggleColumn(c)">{{ t(`summary.column.${c}`) }}</label>
            </fieldset>
            <fieldset class="card">
              <legend class="panel-title">{{ t('summary.groupBy') }}</legend>
              <label v-for="g in GROUPS" :key="g" class="toggle row"><input v-model="groupBy" type="radio" name="groupBy" :value="g">{{ t(`summary.group.${g}`) }}</label>
            </fieldset>
          </div>
        </template>

        <!-- 4. Результат -->
        <template v-else>
          <div v-if="loading" class="muted">{{ t('common.loading') }}</div>
          <template v-else-if="result">
            <div v-if="result.groups.length" class="table-wrap part">
              <table class="table">
                <thead><tr><th>{{ t(`summary.group.${groupBy}`) }}</th><th class="num">{{ t('summary.col.total') }}</th><th class="num">{{ t('enrollment.done') }}</th><th class="num">{{ t('enrollment.in_progress') }}</th><th class="num">{{ t('enrollment.failed') }}</th><th class="num">{{ t('enrollment.not_started') }}</th><th class="num">{{ t('enrollment.not_assigned') }}</th></tr></thead>
                <tbody><tr v-for="g in result.groups" :key="g.key"><td><strong>{{ g.label }}</strong></td><td class="num">{{ g.total }}</td><td class="num">{{ g.done }}</td><td class="num">{{ g.inProgress }}</td><td class="num">{{ g.failed }}</td><td class="num">{{ g.notStarted }}</td><td class="num">{{ g.notAssigned }}</td></tr></tbody>
              </table>
            </div>
            <div class="table-wrap">
              <table v-if="result.rows.length" class="table">
                <thead><tr><ReportFrame part="head" /><th v-for="task in result.tasks" :key="task.id">{{ task.title }}<span class="sub">{{ t(`contentType.${task.contentType}`) }}</span></th></tr></thead>
                <tbody>
                  <tr v-for="r in result.rows" :key="r.user_id">
                    <ReportFrame part="cells" :row="r" />
                    <td v-for="task in result.tasks" :key="task.id">
                      <span :class="['badge', 'upper', cell(r, task.id).status]">{{ t(`enrollment.${cell(r, task.id).status}`) }}</span>
                      <span v-if="cell(r, task.id).result != null" class="sub">{{ cell(r, task.id).result }}%</span>
                    </td>
                  </tr>
                </tbody>
              </table>
              <p v-else class="muted">{{ t('reports.noData') }}</p>
            </div>
          </template>
        </template>
      </section>

      <aside class="side card">
        <h2 class="panel-title">{{ t('summary.selection') }}</h2>
        <p class="muted">{{ t('summary.selectionHint') }}</p>
        <dl class="sel">
          <div><dt>{{ t('summary.peoplePicked') }}</dt><dd>{{ users.count }}</dd></div>
          <div><dt>{{ t('summary.tasksPicked') }}</dt><dd>{{ selectedTasks.length }}</dd></div>
        </dl>
        <div class="actions">
          <button v-if="step > 1" class="btn ghost" @click="go((step - 1) as 1 | 2 | 3 | 4)">{{ t('common.back') }}</button>
          <button v-if="step < 4" class="btn primary" :disabled="step === 2 && !selectedTasks.length" @click="go((step + 1) as 1 | 2 | 3 | 4)">{{ t('common.next') }}</button>
          <button v-else-if="hasScope('report.export')" class="btn primary" :disabled="loading" @click="exportInBackground">{{ t('reports.exportBg') }}</button>
        </div>
      </aside>
    </div>
  </div>
</template>

<style scoped>
.steps { list-style: none; display: flex; gap: var(--space-2); padding: 0; margin: 0 0 var(--space-4); flex-wrap: wrap; }
.step { font: inherit; font-weight: 700; display: inline-flex; align-items: center; gap: var(--space-2); border: 1px solid var(--color-bg-line); background: var(--color-bg-soft); color: var(--color-ink-muted); border-radius: var(--radius-pill); padding: var(--space-2) var(--space-4); cursor: pointer; }
.step b { display: inline-grid; place-items: center; width: 24px; height: 24px; border-radius: 50%; background: var(--color-bg-line); color: var(--color-ink); font-size: 12px; }
.step.on { border-color: var(--color-ink); color: var(--color-ink); }
.step.on b { background: var(--color-sun); }
.step.done b { background: var(--color-teal); color: var(--color-teal-deep); }
.layout { display: grid; grid-template-columns: 1fr; gap: var(--space-4); }
@media (min-width: 960px) { .layout { grid-template-columns: 1fr 300px; align-items: start; } }
.filters { display: flex; gap: var(--space-3); align-items: end; flex-wrap: wrap; margin-bottom: var(--space-3); }
.field { display: grid; gap: var(--space-1); font-size: var(--font-size-body-s); color: var(--color-ink-muted); font-weight: 700; }
select, input[type="search"], input:not([type]) { font: inherit; border: 1px solid var(--color-bg-line); border-radius: var(--radius-s); padding: var(--space-2) var(--space-3); background: var(--color-bg-soft); color: var(--color-ink); max-width: 100%; }
.count { font-weight: 800; margin: var(--space-2) 0; }
.config { display: grid; gap: var(--space-3); }
@media (min-width: 700px) { .config { grid-template-columns: 1fr 1fr; } }
fieldset { border: none; margin: 0; }
.toggle.row { display: flex; padding: var(--space-1) 0; }
.toggle input[type="checkbox"], .toggle input[type="radio"] { appearance: auto; width: auto; height: auto; }
.side { position: sticky; top: var(--space-4); }
.sel { margin: var(--space-3) 0; }
.sel div { display: flex; justify-content: space-between; padding: var(--space-2) 0; border-bottom: 1px solid var(--color-bg-line-soft); }
.sel dd { margin: 0; font-family: ui-monospace, monospace; font-weight: 900; font-size: var(--font-size-title-l); color: var(--color-teal-ink); }
.actions { display: flex; gap: var(--space-2); flex-wrap: wrap; }
.part { margin-bottom: var(--space-4); }
.num { text-align: right; font-variant-numeric: tabular-nums; }
.sub { display: block; font-size: var(--font-size-body-s); color: var(--color-ink-faint); font-weight: 400; text-transform: none; letter-spacing: 0; }
</style>
