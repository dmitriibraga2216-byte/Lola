<script setup lang="ts">
definePageMeta({ layout: 'admin', middleware: 'admin-scope', requiredScope: 'people.import' })

const { t } = useI18n()
const { api } = useApi()

interface ImportRowView { line: number, fullName: string, phone: string, action: 'create' | 'update' | 'skip', errors: string[], warnings?: string[] }
interface ImportStats { total: number, create: number, update: number, skip: number, errors: number, warnings?: number, unmapped?: string[], processed?: number, created?: number, updated?: number, archived?: number, error?: string }
interface Options { createRefs: boolean, archiveMissing: boolean, sendInvites: boolean }
interface HistoryRow { id: string, file_name: string, status: string, stats: ImportStats, created_at: string, created_by_name: string | null }

const COLUMNS = ['ПІБ', 'Прізвище', 'Імʼя', 'По батькові', 'Телефон', 'Email', 'Посада', 'Рівень посади', 'Місто', 'Підрозділ', 'Точка', 'Роль', 'Мітки', 'Дата найму', 'Дата призначення посади', 'Дата народження', 'Гендер', 'Зовнішній ID', 'Керівник (зовнішній ID)']

const file = ref<File | null>(null)
const jobId = ref('')
const stats = ref<ImportStats | null>(null)
const rows = ref<ImportRowView[]>([])
const headers = ref<string[]>([])
const mapping = ref<Record<string, string>>({})
const presetUsed = ref(false)
const options = reactive<Options>({ createRefs: true, archiveMissing: false, sendInvites: false })
// «Не перезаписувати під час імпорту» (docs/16 Г-16.1, docs/24 §3.4.1): список полей из политик тенанта — только показать, правится в настройках
const keepFields = ref<string[]>([])
onMounted(async () => {
  try { keepFields.value = (await api<{ users: { importKeepFields: string[] } }>('/settings/policies')).users.importKeepFields }
  catch { keepFields.value = [] }
})
const applied = ref<ImportStats | null>(null)
const busy = ref(false)
const error = ref('')
const showOnlyErrors = ref(false)
const history = ref<HistoryRow[]>([])
const progress = ref<{ done: number, total: number } | null>(null)

const visibleRows = computed(() => (showOnlyErrors.value ? rows.value.filter(r => r.errors.length > 0) : rows.value).slice(0, 200))
const step = computed(() => applied.value ? 5 : stats.value ? 3 : 1)

function onFile(e: Event) { file.value = (e.target as HTMLInputElement).files?.[0] ?? null }
function onDrop(e: DragEvent) { const f = e.dataTransfer?.files?.[0]; if (f) file.value = f }

function take(res: { jobId: string, stats: ImportStats, rows: ImportRowView[], headers: string[], mapping: Record<string, string>, options?: Partial<Options>, presetUsed?: boolean }) {
  jobId.value = res.jobId
  stats.value = res.stats
  rows.value = res.rows
  headers.value = res.headers
  mapping.value = { ...res.mapping }
  presetUsed.value = Boolean(res.presetUsed)
  if (res.options) Object.assign(options, res.options)
}

async function upload() {
  if (!file.value) return
  busy.value = true
  error.value = ''
  applied.value = null
  try {
    const form = new FormData()
    form.append('file', file.value)
    take(await api('/people/import', { method: 'POST', body: form }))
  }
  catch (err) { error.value = apiErrorOf(err).message }
  finally { busy.value = false }
}

/** Шаги 2 и 4 (docs/16 §5.4): сопоставление и опции → повторная проверка тех же строк. */
async function remap() {
  busy.value = true
  error.value = ''
  try {
    const m = Object.fromEntries(Object.entries(mapping.value).filter(([, v]) => v))
    take(await api(`/people/import/${jobId.value}/mapping`, { method: 'POST', body: { mapping: m, options: { ...options } } }))
  }
  catch (err) { error.value = apiErrorOf(err).message }
  finally { busy.value = false }
}

async function apply() {
  if (options.archiveMissing && !confirm(t('import.archiveMissingWarn'))) return
  busy.value = true
  error.value = ''
  progress.value = { done: 0, total: (stats.value?.create ?? 0) + (stats.value?.update ?? 0) }
  const poll = setInterval(async () => {
    try {
      const j = await api<{ stats: ImportStats }>(`/people/import/${jobId.value}`)
      progress.value = { done: j.stats.processed ?? 0, total: progress.value?.total ?? 0 }
    }
    catch { /* прогресс не обязателен */ }
  }, 1500)
  try {
    const res = await api<{ stats: ImportStats }>(`/people/import/${jobId.value}/apply`, { method: 'POST' })
    applied.value = res.stats
    loadHistory()
  }
  catch (err) { error.value = apiErrorOf(err).message }
  finally { clearInterval(poll); progress.value = null; busy.value = false }
}

async function loadHistory() { try { history.value = await api('/people/import') } catch { /* история не обязательна */ } }
/** Открыть прошлый импорт (из истории или ссылки в уведомлении). */
async function openJob(id: string) {
  error.value = ''
  try {
    const j = await api<{ jobId: string, status: string, stats: ImportStats, rows: ImportRowView[], mapping: Record<string, string> | null, options: Partial<Options> }>(`/people/import/${id}/preview`)
    take({ jobId: j.jobId, stats: j.stats, rows: j.rows, headers: Object.keys(j.mapping ?? {}), mapping: j.mapping ?? {}, options: j.options })
    applied.value = j.status === 'applied' ? j.stats : null
  }
  catch (err) { error.value = apiErrorOf(err).message }
}
onMounted(() => { loadHistory(); const job = useRoute().query.job; if (typeof job === 'string') openJob(job) })
const fmt = (d: string) => new Date(d).toLocaleString('uk')

// Мокап Import (docs/16 §5.4): п'ять джерел вкладками — на R1 готові CSV і API, решта R2
const SOURCES = ['csv', 'api', 'ad', 'azureAd', 'hrm'] as const
type Source = typeof SOURCES[number]
const source = ref<Source>('csv')
</script>

<template>
  <div>
    <h1>{{ t('admin.nav.import') }}</h1>
    <p class="sub">
      {{ t('import.hint') }}
      <a href="/api/v1/people/import/template" download>{{ t('import.template') }}</a>
    </p>

    <div class="chips source-tabs" role="tablist">
      <button v-for="s in SOURCES" :key="s" role="tab" :aria-selected="source === s" :class="['chip', { on: source === s }]" @click="source = s">{{ t(`import.source.${s}`) }}</button>
    </div>

    <section v-if="source === 'api'" class="card">
      <h2>{{ t('import.source.api') }}</h2>
      <p class="sub">{{ t('import.apiHint') }}</p>
      <NuxtLink to="/admin/settings/integrations" class="link">{{ t('admin.nav.integrations') }} →</NuxtLink>
    </section>
    <section v-else-if="source !== 'csv'" class="card">
      <p class="sub">{{ t('import.sourceR2') }}</p>
    </section>

    <template v-if="source === 'csv'">
    <ol class="steps" aria-label="steps">
      <li :class="{ on: step >= 1 }">{{ t('import.step1') }}</li>
      <li :class="{ on: step >= 3 }">{{ t('import.step2') }}</li>
      <li :class="{ on: step >= 3 }">{{ t('import.step3') }}</li>
      <li :class="{ on: step >= 3 }">{{ t('import.step4') }}</li>
      <li :class="{ on: step >= 5 }">{{ t('import.step5') }}</li>
    </ol>

    <div class="upload" @dragover.prevent @drop.prevent="onDrop">
      <input type="file" accept=".xlsx,.csv" :aria-label="t('import.step1')" @change="onFile">
      <button class="primary" :disabled="!file || busy" @click="upload">{{ t('import.validate') }}</button>
    </div>

    <p v-if="error" class="error" role="alert">{{ error }}</p>

    <template v-if="stats">
      <section class="card">
        <h2>{{ t('import.step2') }}</h2>
        <p v-if="presetUsed" class="sub">{{ t('import.presetUsed') }}</p>
        <p v-if="stats.unmapped?.length" class="error">{{ t('import.unmapped', { cols: stats.unmapped.join(', ') }) }}</p>
        <div class="mapping">
          <label v-for="h in headers" :key="h">
            <span class="file-col">{{ h }}</span>
            <select v-model="mapping[h]" :aria-label="`${t('import.fileColumn')} ${h}`">
              <option value="">{{ t('import.skipColumn') }}</option>
              <option v-for="c in COLUMNS" :key="c" :value="c">{{ c }}</option>
            </select>
          </label>
        </div>
      </section>

      <section class="card">
        <h2>{{ t('import.step4') }}</h2>
        <label class="check"><input v-model="options.createRefs" type="checkbox"> {{ t('import.createRefs') }}</label>
        <label class="check"><input v-model="options.archiveMissing" type="checkbox"> {{ t('import.archiveMissing') }}</label>
        <label class="check"><input v-model="options.sendInvites" type="checkbox"> {{ t('import.sendInvites') }}</label>
        <p class="keep">
          <template v-if="keepFields.length">{{ t('import.keepFields') }}: <b>{{ keepFields.map(f => t(`settings.users.fields.${f}`)).join(', ') }}</b></template>
          <template v-else>{{ t('import.keepFieldsNone') }}</template>
          <NuxtLink to="/admin/settings/policies" class="link">{{ t('import.keepFieldsSettings') }}</NuxtLink>
        </p>
        <button v-if="!applied" class="primary" :disabled="busy" @click="remap">{{ t('import.remap') }}</button>
      </section>

      <div class="stats">
        <div class="stat"><b>{{ stats.total }}</b><span>{{ t('import.total') }}</span></div>
        <div class="stat teal"><b>{{ stats.create }}</b><span>{{ t('import.toCreate') }}</span></div>
        <div class="stat sun"><b>{{ stats.update }}</b><span>{{ t('import.toUpdate') }}</span></div>
        <div class="stat coral"><b>{{ stats.skip }}</b><span>{{ t('import.toSkip') }}</span></div>
        <div v-if="stats.warnings" class="stat"><b>{{ stats.warnings }}</b><span>{{ t('import.warnings') }}</span></div>
      </div>

      <div class="controls">
        <label class="check"><input v-model="showOnlyErrors" type="checkbox"> {{ t('import.onlyErrors') }}</label>
        <button v-if="!applied" class="primary" :disabled="busy || stats.create + stats.update === 0" @click="apply">{{ t('import.apply', { n: stats.create + stats.update }) }}</button>
        <span v-if="progress" class="sub" role="status">{{ t('import.progress', { done: progress.done, total: progress.total }) }}</span>
        <a v-if="applied" class="report" :href="`/api/v1/people/import/${jobId}/report`" download>{{ t('import.downloadReport') }}</a>
      </div>

      <p v-if="applied" class="notice" role="status">{{ t('import.appliedResult', { created: applied.created ?? 0, updated: applied.updated ?? 0 }) }}<template v-if="applied.archived"> · {{ t('import.status.archived') }}: {{ applied.archived }}</template></p>

      <div class="table-wrap">
        <table class="table">
          <thead><tr><th>#</th><th>{{ t('people.col.name') }}</th><th>{{ t('person.phone') }}</th><th>{{ t('import.action') }}</th><th>{{ t('import.errors') }}</th></tr></thead>
          <tbody>
            <tr v-for="row in visibleRows" :key="row.line" :class="{ bad: row.errors.length > 0, create: row.action === 'create', update: row.action === 'update' }">
              <td class="sub">{{ row.line }}</td>
              <td>{{ row.fullName }}</td>
              <td>{{ row.phone }}</td>
              <td>{{ t(`import.actions.${row.action}`) }}</td>
              <td class="errors-cell">{{ row.errors.join('; ') }}<span v-if="row.warnings?.length" class="warn"> {{ row.warnings.join('; ') }}</span></td>
            </tr>
          </tbody>
        </table>
      </div>
      <p v-if="rows.length > 200" class="sub">{{ t('import.truncated', { shown: 200, total: rows.length }) }}</p>
    </template>
    </template>

    <section v-if="history.length" class="card history">
      <h2>{{ t('import.history') }}</h2>
      <table class="table">
        <thead><tr><th>{{ t('import.step1') }}</th><th>{{ t('people.col.status') }}</th><th>{{ t('import.total') }}</th><th>{{ t('people.col.registered') }}</th><th /></tr></thead>
        <tbody>
          <tr v-for="h in history" :key="h.id">
            <td><button class="linkbtn" @click="openJob(h.id)">{{ h.file_name }}</button><div class="sub">{{ h.created_by_name || '' }}</div></td>
            <td>{{ t(`import.status.${h.status}`, h.status) }}</td>
            <td class="sub">{{ h.stats.total ?? '—' }} · +{{ h.stats.created ?? h.stats.create ?? 0 }} / ~{{ h.stats.updated ?? h.stats.update ?? 0 }} / ✕{{ h.stats.errors ?? 0 }}</td>
            <td class="sub">{{ fmt(h.created_at) }}</td>
            <td><a class="report" :href="`/api/v1/people/import/${h.id}/report`" download>xlsx</a></td>
          </tr>
        </tbody>
      </table>
    </section>
  </div>
</template>

<style scoped>
.keep { font-size: var(--font-size-body-s); color: var(--color-ink-muted); margin: var(--space-2) 0; }
.keep .link { margin-left: var(--space-2); color: var(--color-teal-ink); }
.source-tabs { display: flex; gap: var(--space-2); flex-wrap: wrap; margin-bottom: var(--space-3); }
.chip { font: inherit; font-size: var(--font-size-body-s); font-weight: 700; border: 1px solid var(--color-bg-line); background: transparent; color: var(--color-ink-muted); border-radius: var(--radius-pill); padding: var(--space-1) var(--space-3); cursor: pointer; }
.chip.on { background: var(--color-ink); border-color: var(--color-ink); color: var(--color-bg-soft); }
.link { color: var(--color-teal-ink); font-weight: 700; text-decoration: none; }
h1 {
  margin: 0 0 var(--space-2);
  font-weight: 900;
}

.sub {
  color: var(--color-ink-muted);
  font-size: var(--font-size-body-s);
}

.sub a {
  color: var(--color-teal-ink);
}

.upload {
  display: flex;
  gap: var(--space-3);
  align-items: center;
  margin: var(--space-4) 0;
  flex-wrap: wrap;
}

.primary {
  font: inherit;
  font-weight: 800;
  border: none;
  background: var(--color-sun);
  color: var(--color-ink);
  border-radius: var(--radius-pill);
  padding: var(--space-2) var(--space-5);
  cursor: pointer;
}

.primary:disabled {
  opacity: 0.5;
}

.stats {
  display: flex;
  gap: var(--space-3);
  margin-bottom: var(--space-4);
  flex-wrap: wrap;
}

.stat {
  background: var(--color-bg-soft);
  border-radius: var(--radius-m);
  padding: var(--space-3) var(--space-5);
  display: grid;
  text-align: center;
}

.stat b {
  font-size: var(--font-size-title-l);
  font-weight: 900;
}

.stat span {
  font-size: var(--font-size-body-s);
  color: var(--color-ink-muted);
}

.stat.teal b { color: var(--color-teal-ink); }
.stat.sun b { color: var(--color-sun-ink); }
.stat.coral b { color: var(--color-coral-ink); }

.controls {
  display: flex;
  align-items: center;
  gap: var(--space-4);
  margin-bottom: var(--space-3);
  flex-wrap: wrap;
}

.check {
  display: flex;
  gap: var(--space-2);
  align-items: center;
  font-size: var(--font-size-body-s);
  color: var(--color-ink-muted);
}

.report {
  color: var(--color-teal-ink);
  font-weight: 700;
}

.notice {
  color: var(--color-teal-ink);
}

.table {
  width: 100%;
  border-collapse: collapse;
  background: var(--color-bg-soft);
  border-radius: var(--radius-m);
  overflow: hidden;
}

th {
  text-align: left;
  font-size: var(--font-size-body-s);
  color: var(--color-ink-muted);
  padding: var(--space-2) var(--space-3);
  border-bottom: 1px solid var(--color-bg-line);
}

td {
  padding: var(--space-2) var(--space-3);
  border-bottom: 1px solid var(--color-bg-line-soft);
}

.bad { background: color-mix(in srgb, var(--color-coral) 12%, transparent); }
.create { background: color-mix(in srgb, var(--color-teal) 10%, transparent); }
.update { background: color-mix(in srgb, var(--color-sun) 12%, transparent); }
.warn { color: var(--color-sun-ink); }
.steps { display: flex; gap: var(--space-2); list-style: none; margin: 0 0 var(--space-3); padding: 0; flex-wrap: wrap; font-size: var(--font-size-body-s); color: var(--color-ink-faint); }
.steps li { border: 1px solid var(--color-bg-line); border-radius: var(--radius-pill); padding: 2px var(--space-3); }
.steps li.on { background: var(--color-sun); color: var(--color-ink); border-color: var(--color-sun); font-weight: 700; }
.card { background: var(--color-bg-soft); border-radius: var(--radius-m); padding: var(--space-3); margin-bottom: var(--space-3); display: grid; gap: var(--space-2); }
.card h2 { margin: 0; font-size: var(--font-size-body); font-weight: 800; }
.mapping { display: grid; grid-template-columns: repeat(auto-fill, minmax(220px, 1fr)); gap: var(--space-2); }
.mapping label { display: grid; gap: var(--space-1); font-size: var(--font-size-body-s); }
.file-col { font-weight: 700; color: var(--color-ink); overflow-wrap: anywhere; }
select { font: inherit; border: 1px solid var(--color-bg-line); border-radius: var(--radius-s); padding: var(--space-1) var(--space-2); background: var(--color-bg); color: var(--color-ink); }
.table-wrap { overflow-x: auto; }
.history { margin-top: var(--space-4); }
.linkbtn { font: inherit; font-weight: 700; border: none; background: transparent; color: var(--color-ink); cursor: pointer; padding: 0; text-align: left; }

.errors-cell {
  color: var(--color-coral-ink);
  font-size: var(--font-size-body-s);
}

.error {
  color: var(--color-coral-ink);
}
</style>
