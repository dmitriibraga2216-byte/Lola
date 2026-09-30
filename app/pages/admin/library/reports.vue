<script setup lang="ts">
/**
 * Отчёты библиотеки модулей — `/admin/library/reports` (docs/v2/31 §9): «Використання
 * бібліотеки», «Застарілі посилання», «Пропозиції до бібліотеки». Строки считает сервер
 * (`GET /library/reports/:kind`), выгрузка — фоном тем же набором фильтров
 * (`POST /reports/library-<kind>/export`, ссылка живёт 24 часа). Администратору ниже —
 * последние прогоны служебных задач `library.orphan_scan` и `library.version_retire` (§11).
 */
import { LIBRARY_PROPOSAL_STATUSES } from '#shared/enums'
import type {
  LibraryProposalReportRow, LibraryReportKind, LibraryScansView, LibraryStaleReportRow, LibraryUsageReportRow,
} from '#shared/schemas/library'

definePageMeta({ layout: 'admin', middleware: 'admin-scope', requiredScope: 'library.view' })

const { t } = useI18n()
const { api } = useApi()
const { hasScope } = useAuth()
const { formatShortDate, formatNumber } = useFormat()

const KINDS = ['article', 'file', 'video', 'link'] as const
const tabs: LibraryReportKind[] = ['usage', 'stale', 'proposals']
const tab = ref<LibraryReportKind>('usage')

const filters = reactive({
  from: new Date(Date.now() - 29 * 86_400_000).toISOString().slice(0, 10),
  to: new Date().toISOString().slice(0, 10),
  kind: '',
  categoryId: '',
  ownerId: '',
  onlyUnused: false,
  authorId: '',
  minLag: '',
  status: '',
})
const rows = ref<unknown[] | null>(null)
const error = ref('')
const busy = ref(false)
const exportNotice = ref('')

/** Варианты фильтров «Категорія», «Власник», «Автор» — из первого нефильтрованного ответа. */
const owners = ref<{ id: string, name: string }[]>([])
const categories = ref<{ id: string, name: string }[]>([])
const authors = ref<{ id: string, name: string }[]>([])

function query(): Record<string, string> {
  const q: Record<string, string> = {}
  if (tab.value !== 'stale') {
    if (filters.from) q.from = filters.from
    if (filters.to) q.to = filters.to
  }
  if (tab.value === 'usage') {
    if (filters.kind) q.kind = filters.kind
    if (filters.categoryId) q.categoryId = filters.categoryId
    if (filters.ownerId) q.ownerId = filters.ownerId
    if (filters.onlyUnused) q.onlyUnused = 'true'
  }
  if (tab.value === 'stale') {
    if (filters.authorId) q.authorId = filters.authorId
    if (filters.minLag) q.minLag = filters.minLag
  }
  if (tab.value === 'proposals' && filters.status) q.status = filters.status
  return q
}

function uniq<T extends { id: string }>(list: T[]): T[] {
  return [...new Map(list.map(x => [x.id, x])).values()].sort((a, b) => (a as unknown as { name: string }).name.localeCompare((b as unknown as { name: string }).name))
}

async function load() {
  busy.value = true
  error.value = ''
  rows.value = null
  try {
    const q = query()
    const data = (await api<{ rows: unknown[] }>(`/library/reports/${tab.value}`, { query: q })).rows
    rows.value = data
    if (tab.value === 'usage' && !q.ownerId && !q.categoryId && !owners.value.length) {
      const u = data as LibraryUsageReportRow[]
      owners.value = uniq(u.map(r => ({ id: r.ownerId, name: r.owner ?? '—' })))
      categories.value = uniq(u.filter(r => r.categoryId).map(r => ({ id: r.categoryId!, name: r.category ?? '—' })))
    }
    if (tab.value === 'stale' && !q.authorId && !authors.value.length) {
      authors.value = uniq((data as LibraryStaleReportRow[]).filter(r => r.authorId).map(r => ({ id: r.authorId!, name: r.author ?? '—' })))
    }
  }
  catch (err) { error.value = apiErrorOf(err).message || t('libraryReports.loadError') }
  finally { busy.value = false }
}
onMounted(load)
watch(tab, () => { exportNotice.value = ''; load() })

async function exportInBackground(format: 'xlsx' | 'csv') {
  exportNotice.value = ''
  try {
    const r = await api<{ exportId: string }>(`/reports/library-${tab.value}/export`, { method: 'POST', body: { filters: query(), format } })
    exportNotice.value = t('reports.exportQueued', { id: r.exportId.slice(0, 8) })
  }
  catch (err) { error.value = apiErrorOf(err).message || t('libraryReports.loadError') }
}

const scans = ref<LibraryScansView | null>(null)
onMounted(async () => {
  if (!hasScope('library.manage')) return
  try { scans.value = await api<LibraryScansView>('/library/scans') }
  catch { scans.value = null }
})

const date = (v: string | null) => v ? formatShortDate(v) : '—'
const pct = (v: number | null) => v === null ? '—' : `${formatNumber(v, { maximumFractionDigits: 1 })} %`
const usage = computed(() => (tab.value === 'usage' ? rows.value : null) as LibraryUsageReportRow[] | null)
const stale = computed(() => (tab.value === 'stale' ? rows.value : null) as LibraryStaleReportRow[] | null)
const proposals = computed(() => (tab.value === 'proposals' ? rows.value : null) as LibraryProposalReportRow[] | null)
const containerLink = (r: LibraryStaleReportRow) => r.containerType === 'trajectory' ? `/admin/trajectories/${r.containerId}` : `/admin/courses/${r.containerId}`
</script>

<template>
  <div>
    <PageHeader :title="t('libraryReports.title')" :subtitle="t('libraryReports.hint')">
      <template #actions>
        <template v-if="hasScope('report.export') && hasScope('report.team')">
          <button type="button" class="btn ghost" @click="exportInBackground('xlsx')">{{ t('libraryReports.exportXlsx') }}</button>
          <button type="button" class="btn ghost" @click="exportInBackground('csv')">{{ t('libraryReports.exportCsv') }}</button>
        </template>
      </template>
    </PageHeader>

    <div class="chips tabs" role="tablist">
      <button
        v-for="k in tabs" :key="k" type="button" role="tab" :aria-selected="tab === k"
        :class="['chip', { on: tab === k }]" @click="tab = k"
      >
        {{ t(`libraryReports.tab.${k}`) }}
      </button>
    </div>

    <form class="filters" @submit.prevent="load">
      <template v-if="tab !== 'stale'">
        <div class="date-label"><label for="lr-from">{{ t('libraryReports.from') }}</label> <input id="lr-from" v-model="filters.from" class="field" type="date"></div>
        <div class="date-label"><label for="lr-to">{{ t('libraryReports.to') }}</label> <input id="lr-to" v-model="filters.to" class="field" type="date"></div>
      </template>
      <template v-if="tab === 'usage'">
        <label>{{ t('libraryReports.col.kind') }}
          <select v-model="filters.kind" class="field">
            <option value="">{{ t('libraryReports.any') }}</option>
            <option v-for="k in KINDS" :key="k" :value="k">{{ t(`resource.kind.${k}`) }}</option>
          </select>
        </label>
        <label>{{ t('libraryReports.col.category') }}
          <select v-model="filters.categoryId" class="field">
            <option value="">{{ t('libraryReports.any') }}</option>
            <option v-for="c in categories" :key="c.id" :value="c.id">{{ c.name }}</option>
          </select>
        </label>
        <label>{{ t('libraryReports.col.owner') }}
          <select v-model="filters.ownerId" class="field">
            <option value="">{{ t('libraryReports.any') }}</option>
            <option v-for="o in owners" :key="o.id" :value="o.id">{{ o.name }}</option>
          </select>
        </label>
        <label class="check"><input v-model="filters.onlyUnused" type="checkbox"> {{ t('libraryReports.onlyUnused') }}</label>
      </template>
      <template v-if="tab === 'stale'">
        <label>{{ t('libraryReports.col.author') }}
          <select v-model="filters.authorId" class="field">
            <option value="">{{ t('libraryReports.any') }}</option>
            <option v-for="o in authors" :key="o.id" :value="o.id">{{ o.name }}</option>
          </select>
        </label>
        <label>{{ t('libraryReports.minLag') }}
          <input v-model="filters.minLag" class="field" type="number" min="1" inputmode="numeric">
        </label>
      </template>
      <label v-if="tab === 'proposals'">{{ t('libraryReports.col.status') }}
        <select v-model="filters.status" class="field">
          <option value="">{{ t('libraryReports.any') }}</option>
          <option v-for="s in LIBRARY_PROPOSAL_STATUSES" :key="s" :value="s">{{ t(`libraryReports.proposalStatus.${s}`) }}</option>
        </select>
      </label>
      <button class="btn primary" type="submit" :disabled="busy">{{ t('libraryReports.apply') }}</button>
    </form>

    <p v-if="exportNotice" class="note teal" role="status">{{ exportNotice }}</p>
    <div v-if="error" class="note coral" role="alert">
      {{ error }}
      <button type="button" class="btn ghost" @click="load">{{ t('libraryReports.retry') }}</button>
    </div>
    <p v-else-if="!rows" class="muted" aria-busy="true">{{ t('libraryReports.loading') }}</p>
    <p v-else-if="rows.length === 0" class="muted">{{ t(`libraryReports.empty.${tab}`) }}</p>

    <div v-else-if="usage" class="table-wrap">
      <table class="table">
        <thead>
          <tr>
            <th>{{ t('libraryReports.col.module') }}</th>
            <th>{{ t('libraryReports.col.kind') }}</th>
            <th>{{ t('libraryReports.col.category') }}</th>
            <th>{{ t('libraryReports.col.owner') }}</th>
            <th>{{ t('libraryReports.col.version') }}</th>
            <th class="num">{{ t('libraryReports.col.usages') }}</th>
            <th class="num">{{ t('libraryReports.col.stale') }}</th>
            <th class="num">{{ t('libraryReports.col.opens') }}</th>
            <th class="num">{{ t('libraryReports.col.completion') }}</th>
            <th>{{ t('libraryReports.col.updatedAt') }}</th>
          </tr>
        </thead>
        <tbody>
          <tr v-for="r in usage" :key="r.moduleId">
            <td>
              {{ r.title }}
              <span v-if="r.status !== 'published'" class="muted">· {{ t(`libraryReports.moduleStatus.${r.status}`) }}</span>
            </td>
            <td>{{ t(`resource.kind.${r.contentKind}`) }}</td>
            <td>{{ r.category ?? '—' }}</td>
            <td>{{ r.owner ?? '—' }}</td>
            <td>{{ r.version ? t('libraryReports.versionAt', { v: r.version, date: date(r.versionAt) }) : t('libraryReports.noVersion') }}</td>
            <td class="num">{{ r.usages }}</td>
            <td :class="['num', { coral: r.stale > 0 }]">{{ r.stale }}</td>
            <td class="num">{{ r.opens }}</td>
            <td class="num">{{ pct(r.completionPct) }}</td>
            <td>{{ date(r.updatedAt) }}</td>
          </tr>
        </tbody>
      </table>
    </div>

    <div v-else-if="stale" class="table-wrap">
      <table class="table">
        <thead>
          <tr>
            <th>{{ t('libraryReports.col.container') }}</th>
            <th>{{ t('libraryReports.col.holder') }}</th>
            <th>{{ t('libraryReports.col.module') }}</th>
            <th class="num">{{ t('libraryReports.col.pinned') }}</th>
            <th class="num">{{ t('libraryReports.col.latest') }}</th>
            <th class="num">{{ t('libraryReports.col.lag') }}</th>
            <th class="num">{{ t('libraryReports.col.days') }}</th>
            <th>{{ t('libraryReports.col.author') }}</th>
          </tr>
        </thead>
        <tbody>
          <tr v-for="r in stale" :key="r.usageId">
            <td><NuxtLink :to="containerLink(r)">{{ r.containerTitle }}</NuxtLink></td>
            <td>{{ r.holderTitle ?? '—' }}</td>
            <td>{{ r.moduleTitle }}</td>
            <td class="num coral">v{{ r.pinnedVersion }}</td>
            <td class="num">v{{ r.latestVersion }}</td>
            <td class="num">{{ r.lag }}</td>
            <td class="num">{{ r.daysSinceNewer }}</td>
            <td>{{ r.author ?? '—' }}</td>
          </tr>
        </tbody>
      </table>
    </div>

    <div v-else-if="proposals" class="table-wrap">
      <table class="table">
        <thead>
          <tr>
            <th>{{ t('libraryReports.col.sourceLesson') }}</th>
            <th>{{ t('libraryReports.col.container') }}</th>
            <th>{{ t('libraryReports.col.proposedBy') }}</th>
            <th>{{ t('libraryReports.col.createdAt') }}</th>
            <th>{{ t('libraryReports.col.status') }}</th>
            <th>{{ t('libraryReports.col.decidedBy') }}</th>
            <th>{{ t('libraryReports.col.decision') }}</th>
          </tr>
        </thead>
        <tbody>
          <tr v-for="r in proposals" :key="r.id">
            <td>{{ r.sourceLessonTitle || '—' }}</td>
            <td>{{ r.containerTitle ?? '—' }}</td>
            <td>{{ r.proposedBy }}</td>
            <td>{{ date(r.createdAt) }}</td>
            <td>{{ t(`libraryReports.proposalStatus.${r.status}`) }}</td>
            <td>{{ r.decidedBy ?? '—' }}</td>
            <td>{{ r.decisionComment ?? '—' }}</td>
          </tr>
        </tbody>
      </table>
    </div>

    <section v-if="hasScope('library.manage')" class="scans" :aria-label="t('libraryReports.scans.title')">
      <h2>{{ t('libraryReports.scans.title') }}</h2>
      <p>
        <strong>{{ t('libraryReports.scans.orphan') }}:</strong>
        <template v-if="scans?.orphanScan">
          {{ date(scans.orphanScan.at) }} ·
          <span :class="{ coral: scans.orphanScan.report.found > 0 }">{{ t('libraryReports.scans.found', { n: scans.orphanScan.report.found }) }}</span>
        </template>
        <span v-else class="muted">{{ t('libraryReports.scans.never') }}</span>
      </p>
      <ul v-if="scans?.orphanScan?.report.found" class="scan-list">
        <li v-for="m in scans.orphanScan.report.modules" :key="`m-${m.moduleId}`">{{ m.title }} — {{ t(`libraryReports.scans.problem.${m.problem}`) }}</li>
        <li v-for="l in scans.orphanScan.report.lessons" :key="`l-${l.lessonId}`">{{ t('libraryReports.scans.orphanLesson', { title: l.title }) }}</li>
      </ul>
      <p v-if="scans?.orphanScan?.report.found" class="muted">{{ t('libraryReports.scans.orphanHint') }}</p>
      <p>
        <strong>{{ t('libraryReports.scans.retire') }}:</strong>
        <template v-if="scans?.versionRetire">
          {{ date(scans.versionRetire.at) }} · {{ t('libraryReports.scans.retired', { n: scans.versionRetire.report.retired }) }}
        </template>
        <span v-else class="muted">{{ t('libraryReports.scans.noRetire') }}</span>
      </p>
    </section>
  </div>
</template>

<style scoped>
.tabs { margin-bottom: var(--space-3); }
.filters { display: flex; flex-wrap: wrap; gap: var(--space-2); align-items: end; margin-bottom: var(--space-3); }
.filters label, .filters .date-label { display: grid; gap: var(--space-1); font-size: var(--font-size-body-s); font-weight: 700; }
.filters label.check { display: flex; align-items: center; gap: var(--space-1); }
.filters .field { width: auto; min-width: 140px; padding: var(--space-2) var(--space-3); }
.coral { color: var(--color-coral-deep); font-weight: 800; }
.scans { margin-top: var(--space-5); display: grid; gap: var(--space-2); }
.scans h2 { font-size: var(--font-size-title-l); margin: 0; }
.scans p { margin: 0; overflow-wrap: anywhere; }
.scan-list { margin: 0; padding-left: var(--space-4); overflow-wrap: anywhere; }
@media (max-width: 480px) {
  .filters { flex-direction: column; align-items: stretch; }
  .filters .field { width: 100%; }
}
</style>
