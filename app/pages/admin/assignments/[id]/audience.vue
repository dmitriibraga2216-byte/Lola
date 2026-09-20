<script setup lang="ts">
/**
 * Аудитория назначения по мокапу TaskAudience (docs/15 §14.4): вкладки Усі · Призначено · Не призначено,
 * фильтры-чипы, «Призначити вибраним», «Призначити через CSV» (Г-15.4), таблица с «Призначити» по строке
 * и колонкой «Спосіб призначення»; конструктор аудитории — четыре измерения с «Всі, окрім».
 */
definePageMeta({ layout: 'admin', middleware: 'admin-scope', requiredScope: 'assignment.create' })

const { t } = useI18n()
const { api } = useApi()
const route = useRoute()
const id = route.params.id as string

interface Row { userId: string, fullName: string, position: string | null, orgUnit: string | null, location: string | null, city: string | null, registeredAt: string, assigned: boolean, assignedAt: string | null, via: string | null, enrollmentId: string | null }
interface Ref { id: string, name: string }
type Tab = 'all' | 'assigned' | 'unassigned'
const VIA = ['manual', 'auto', 'catalog', 'trajectory', 'import', 'self', 'repeat'] as const

const title = ref('')
const tab = ref<Tab>('all')
const counts = ref({ all: 0, assigned: 0, unassigned: 0 })
const items = ref<Row[]>([])
const filter = reactive({ q: '', positionId: '', cityId: '', locationId: '', tag: '', positionLevelId: '', via: '' })
const refs = reactive<{ positions: Ref[], cities: Ref[], locations: Ref[], tags: Ref[], levels: Ref[], orgUnits: Ref[] }>({ positions: [], cities: [], locations: [], tags: [], levels: [], orgUnits: [] })
const selected = ref<string[]>([])
const error = ref('')
const notice = ref('')
const busy = ref(false)

// Конструктор: четыре измерения, у каждого режим any | include | exclude
type Dim = 'city' | 'position' | 'org_unit' | 'tag'
const DIMS: Dim[] = ['city', 'position', 'org_unit', 'tag']
const builderOpen = ref(false)
const builder = reactive<Record<Dim, { mode: 'any' | 'include' | 'exclude', values: string[] }>>({ city: { mode: 'any', values: [] }, position: { mode: 'any', values: [] }, org_unit: { mode: 'any', values: [] }, tag: { mode: 'any', values: [] } })
const builderPreview = ref<{ count: number, alreadyAssigned: number } | null>(null)
const dimOptions = (d: Dim): Ref[] => d === 'city' ? refs.cities : d === 'position' ? refs.positions : d === 'org_unit' ? refs.orgUnits : refs.tags.map(x => ({ id: x.name, name: x.name }))
const builderPayload = () => ({ dimensions: DIMS.map(d => ({ dimension: d, mode: builder[d].mode, values: builder[d].values })) })

// CSV
const csvOpen = ref(false)
const csvFile = ref<File | null>(null)
const csvPreview = ref<{ jobId: string, keyColumn: string, stats: { total: number, found: number, notFound: number, alreadyAssigned: number, errors: number }, rows: { line: number, value: string, fullName: string | null, status: string, dueAt: string | null }[] } | null>(null)

async function load() {
  try {
    const query: Record<string, string> = { tab: tab.value, limit: '500' }
    for (const [k, v] of Object.entries(filter)) if (v) query[k] = v
    const r = await api<{ counts: typeof counts.value, items: Row[] }>(`/tasks/${id}/audience`, { query })
    counts.value = r.counts
    items.value = r.items
    selected.value = selected.value.filter(s => items.value.some(i => i.userId === s))
  }
  catch (err) { error.value = apiErrorOf(err).message }
}
onMounted(async () => {
  try {
    const [card, p, c, l, tg, lv, ou] = await Promise.all([
      api<{ title: string }>(`/tasks/${id}`),
      api<Ref[]>('/refs/positions'), api<Ref[]>('/refs/cities').catch(() => []), api<Ref[]>('/refs/locations'), api<Ref[]>('/refs/tags?scope=user').catch(() => []),
      api<Ref[]>('/refs/position-levels').catch(() => []), api<Ref[]>('/refs/org-units').catch(() => []),
    ])
    title.value = card.title
    Object.assign(refs, { positions: p, cities: c, locations: l, tags: tg, levels: lv, orgUnits: ou })
  }
  catch (err) { error.value = apiErrorOf(err).message }
  await load()
})
watch(tab, load)
let timer: ReturnType<typeof setTimeout>
watch(filter, () => { clearTimeout(timer); timer = setTimeout(load, 300) })

async function assign(userIds: string[]) {
  if (!userIds.length) return
  busy.value = true
  error.value = ''
  try {
    const r = await api<{ added: number, reopened: number }>(`/tasks/${id}/audience/assign`, { method: 'POST', body: { userIds } })
    notice.value = t('assign.aud.assigned_n', { n: r.added, m: r.reopened })
    selected.value = []
    await load()
  }
  catch (err) { error.value = apiErrorOf(err).message }
  finally { busy.value = false }
}
async function remove(row: Row) {
  if (!confirm(t('assign.aud.removeConfirm', { name: row.fullName }))) return
  try { await api(`/tasks/${id}/audience/${row.userId}`, { method: 'DELETE' }); await load() }
  catch (err) { error.value = apiErrorOf(err).message }
}

let bTimer: ReturnType<typeof setTimeout>
watch(builder, () => {
  clearTimeout(bTimer)
  bTimer = setTimeout(async () => {
    try { builderPreview.value = await api(`/tasks/${id}/audience/preview`, { method: 'POST', body: builderPayload() }) }
    catch { builderPreview.value = null }
  }, 300)
}, { deep: true })
async function applyBuilder() {
  busy.value = true
  error.value = ''
  try {
    const r = await api<{ added: number, reopened: number }>(`/tasks/${id}/audience/assign`, { method: 'POST', body: { filter: builderPayload() } })
    notice.value = t('assign.aud.assigned_n', { n: r.added, m: r.reopened })
    builderOpen.value = false
    await load()
  }
  catch (err) { error.value = apiErrorOf(err).message }
  finally { busy.value = false }
}

async function uploadCsv() {
  if (!csvFile.value) return
  busy.value = true
  error.value = ''
  try {
    const form = new FormData()
    form.append('file', csvFile.value)
    csvPreview.value = await api(`/tasks/${id}/audience/import`, { method: 'POST', body: form })
  }
  catch (err) { error.value = apiErrorOf(err).message }
  finally { busy.value = false }
}
async function applyCsv() {
  if (!csvPreview.value) return
  busy.value = true
  try {
    const r = await api<{ added: number }>(`/tasks/${id}/audience/import/${csvPreview.value.jobId}`, { method: 'POST', body: {} })
    notice.value = t('assign.aud.csvApplied', { n: r.added })
    csvOpen.value = false
    csvPreview.value = null
    csvFile.value = null
    await load()
  }
  catch (err) { error.value = apiErrorOf(err).message }
  finally { busy.value = false }
}
function onFile(e: Event) { csvFile.value = (e.target as HTMLInputElement).files?.[0] ?? null; csvPreview.value = null }

const allSelected = computed(() => items.value.length > 0 && items.value.every(i => selected.value.includes(i.userId)))
function toggleAll() { selected.value = allSelected.value ? [] : items.value.map(i => i.userId) }
const fmt = (d: string | null) => d ? new Date(d).toLocaleDateString('uk') : '—'
</script>

<template>
  <div>
    <PageHeader :title="t('assign.aud.title')" :crumbs="[{ label: t('admin.section.learning') }, { label: t('admin.nav.assignments'), to: '/admin/assignments' }, { label: title, to: `/admin/assignments/${id}` }]">
      <template #actions>
        <button class="btn ghost" @click="builderOpen = !builderOpen">{{ t('assign.aud.builder') }}</button>
        <button class="btn ghost" @click="csvOpen = !csvOpen">{{ t('assign.aud.csv') }}</button>
        <button class="btn primary" :disabled="!selected.length || busy" @click="assign(selected)">{{ t('assign.aud.assignSelected') }}</button>
      </template>
    </PageHeader>
    <p v-if="error" class="error-text">{{ error }}</p>
    <p v-if="notice" class="note teal">{{ notice }}</p>

    <div class="chips tabs" role="tablist">
      <button v-for="k in (['all', 'assigned', 'unassigned'] as const)" :key="k" role="tab" :aria-selected="tab === k" :class="['chip', { on: tab === k }]" @click="tab = k">{{ t(`assign.aud.${k}`) }} · {{ counts[k] }}</button>
    </div>
    <div class="chips filters">
      <input v-model="filter.q" class="field search" :placeholder="t('assign.aud.search')" :aria-label="t('assign.aud.search')">
      <select v-model="filter.positionId" class="field sel" :aria-label="t('assign.aud.position')"><option value="">{{ t('assign.aud.position') }}</option><option v-for="r in refs.positions" :key="r.id" :value="r.id">{{ r.name }}</option></select>
      <select v-model="filter.cityId" class="field sel" :aria-label="t('assign.aud.city')"><option value="">{{ t('assign.aud.city') }}</option><option v-for="r in refs.cities" :key="r.id" :value="r.id">{{ r.name }}</option></select>
      <select v-model="filter.locationId" class="field sel" :aria-label="t('assign.aud.location')"><option value="">{{ t('assign.aud.location') }}</option><option v-for="r in refs.locations" :key="r.id" :value="r.id">{{ r.name }}</option></select>
      <select v-model="filter.tag" class="field sel" :aria-label="t('assign.aud.tags')"><option value="">{{ t('assign.aud.tags') }}</option><option v-for="r in refs.tags" :key="r.id" :value="r.name">{{ r.name }}</option></select>
      <select v-model="filter.positionLevelId" class="field sel" :aria-label="t('assign.aud.level')"><option value="">{{ t('assign.aud.level') }}</option><option v-for="r in refs.levels" :key="r.id" :value="r.id">{{ r.name }}</option></select>
      <select v-model="filter.via" class="field sel" :aria-label="t('assign.aud.via')"><option value="">{{ t('assign.aud.via') }}</option><option v-for="v in VIA" :key="v" :value="v">{{ t(`assign.aud.viaValues.${v}`) }}</option></select>
      <span class="muted">{{ t('assign.aud.selected', { n: selected.length, total: counts.all }) }}</span>
    </div>

    <!-- Конструктор аудитории: четыре измерения, «Всі, окрім» -->
    <section v-if="builderOpen" class="card builder">
      <h2 class="panel-title">{{ t('assign.aud.builder') }}</h2>
      <div v-for="d in DIMS" :key="d" class="dim">
        <span class="label">{{ t(`assign.aud.dims.${d}`) }}</span>
        <div class="segmented" role="radiogroup">
          <button v-for="m in (['any', 'include', 'exclude'] as const)" :key="m" type="button" :class="{ on: builder[d].mode === m }" @click="builder[d].mode = m">{{ t(`assign.aud.modes.${m}`) }}</button>
        </div>
        <select v-if="builder[d].mode !== 'any'" v-model="builder[d].values" multiple class="field multi" :aria-label="t(`assign.aud.dims.${d}`)">
          <option v-for="o in dimOptions(d)" :key="o.id" :value="o.id">{{ o.name }}</option>
        </select>
      </div>
      <p class="muted"><b>{{ t('assign.aud.willAssign', { n: builderPreview?.count ?? 0 }) }}</b><template v-if="builderPreview?.alreadyAssigned"> · {{ t('assign.aud.alreadyAssigned', { n: builderPreview.alreadyAssigned }) }}</template></p>
      <div class="row-actions">
        <button class="btn ghost small" @click="builderOpen = false">{{ t('common.cancel') }}</button>
        <button class="btn primary small" :disabled="!builderPreview?.count || busy" @click="applyBuilder">{{ t('assign.aud.applyBuilder') }}</button>
      </div>
    </section>

    <!-- CSV (Г-15.4): предпросмотр → подтверждение -->
    <section v-if="csvOpen" class="card builder">
      <h2 class="panel-title">{{ t('assign.aud.csv') }}</h2>
      <p class="help">{{ t('assign.aud.csvHint') }}</p>
      <div class="row-actions">
        <input type="file" accept=".csv,text/csv" @change="onFile">
        <button class="btn ghost small" :disabled="!csvFile || busy" @click="uploadCsv">{{ t('assign.aud.csvPreview') }}</button>
      </div>
      <template v-if="csvPreview">
        <div class="chips">
          <span class="chip on">{{ t('assign.aud.csvFound', { n: csvPreview.stats.found }) }}</span>
          <span class="chip">{{ t('assign.aud.csvAlready', { n: csvPreview.stats.alreadyAssigned }) }}</span>
          <span class="chip coral on">{{ t('assign.aud.csvNotFound', { n: csvPreview.stats.notFound }) }}</span>
          <span class="chip coral on">{{ t('assign.aud.csvErrors', { n: csvPreview.stats.errors }) }}</span>
        </div>
        <div class="table-wrap">
          <table class="table small">
            <tbody>
              <tr v-for="r in csvPreview.rows.slice(0, 50)" :key="r.line"><td class="num">{{ r.line }}</td><td>{{ r.value }}</td><td>{{ r.fullName ?? '—' }}</td><td>{{ fmt(r.dueAt) }}</td><td><span :class="['badge', r.status === 'found' ? 'teal' : r.status === 'already_assigned' ? 'muted' : 'coral']">{{ t(`assign.aud.csvRow.${r.status}`) }}</span></td></tr>
            </tbody>
          </table>
        </div>
        <div class="row-actions">
          <button class="btn ghost small" @click="csvOpen = false; csvPreview = null">{{ t('common.cancel') }}</button>
          <button class="btn primary small" :disabled="!csvPreview.stats.found || busy" @click="applyCsv">{{ t('assign.aud.csvApply') }}</button>
        </div>
      </template>
    </section>

    <div class="table-wrap">
      <table class="table">
        <thead>
          <tr>
            <th><input type="checkbox" :checked="allSelected" :aria-label="t('assign.aud.all')" @change="toggleAll"></th>
            <th>{{ t('assign.aud.colName') }}</th><th>{{ t('assign.aud.colPosition') }}</th><th>{{ t('assign.aud.colOrgUnit') }}</th>
            <th>{{ t('assign.aud.colRegistered') }}</th><th>{{ t('assign.aud.colAssigned') }}</th><th>{{ t('assign.aud.colVia') }}</th><th />
          </tr>
        </thead>
        <tbody>
          <tr v-for="r in items" :key="r.userId">
            <td><input v-model="selected" type="checkbox" :value="r.userId" :aria-label="r.fullName"></td>
            <td><b>{{ r.fullName }}</b></td>
            <td>{{ r.position ?? '—' }}</td>
            <td>{{ r.location ?? r.orgUnit ?? '—' }}</td>
            <td class="muted">{{ fmt(r.registeredAt) }}</td>
            <td class="muted">{{ fmt(r.assignedAt) }}</td>
            <td><span v-if="r.via" class="badge">{{ t(`assign.aud.viaValues.${r.via}`) }}</span><span v-else>—</span></td>
            <td class="num">
              <button v-if="!r.assigned" class="btn ghost small" :disabled="busy" @click="assign([r.userId])">{{ t('assign.aud.assign') }}</button>
              <button v-else class="chip" @click="remove(r)">{{ t('assign.aud.remove') }}</button>
            </td>
          </tr>
          <tr v-if="items.length === 0"><td colspan="8" class="empty">{{ t('assign.aud.empty') }}</td></tr>
        </tbody>
      </table>
    </div>
  </div>
</template>

<style scoped>
.tabs { margin-bottom: var(--space-3); }
.filters { margin-bottom: var(--space-3); }
.search { width: 200px; padding: var(--space-2) var(--space-3); }
.sel { width: auto; padding: var(--space-2) var(--space-3); }
.builder { display: grid; gap: var(--space-3); margin-bottom: var(--space-3); }
.dim { display: flex; flex-wrap: wrap; gap: var(--space-2) var(--space-3); align-items: center; }
.dim .label { margin: 0; min-width: 90px; }
.multi { width: min(320px, 100%); min-height: 90px; }
.row-actions { display: flex; gap: var(--space-2); flex-wrap: wrap; align-items: center; }
.table.small td { padding: var(--space-1) var(--space-3); font-size: var(--font-size-body-s); }
.empty { color: var(--color-ink-faint); text-align: center; padding: var(--space-6); }
@media (max-width: 600px) { .search { width: 100%; } }
</style>
