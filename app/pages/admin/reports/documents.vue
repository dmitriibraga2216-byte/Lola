<script setup lang="ts">
/**
 * «Документи співробітників» и «Прострочені та близькі до завершення» — `/admin/reports/documents`
 * (docs/v2/38 §9 п. 1–2; API `/reports/documents`). Вкладка «Прострочені…» фиксирует статус
 * `expiring`/`expired` и сортирует по сроку; режим «Тільки відсутні обовʼязкові» показывает людей
 * без обязательного документа. Область и видимые типы решает сервер (§2). На узком экране фильтры
 * встают столбиком, таблица прокручивается в своей рамке.
 */
import { PERSON_DOCUMENT_STATUSES } from '#shared/enums'
import type { PersonDocumentStatus } from '#shared/enums'

definePageMeta({ layout: 'admin', middleware: 'admin-scope', requiredAnyScope: ['person.document.view_others', 'person.document.manage'] })

interface Row {
  userId: string, fullName: string, position: string | null, location: string | null, documentId: string | null
  typeId: string, type: string, status: PersonDocumentStatus | null, issuedAt: string | null, expiresAt: string | null
  daysLeft: number | null, uploadedBy: string | null, selfUploaded: boolean
}
interface Ref { id: string, name: string }

const { t } = useI18n()
const { api } = useApi()
const { hasScope } = useAuth()
const { formatShortDate } = useFormat()

const preset = ref<'all' | 'expiring'>('all')
const filters = reactive({ locationId: '', positionId: '', typeId: '', status: '', expiresFrom: '', expiresTo: '', missingOnly: false, q: '' })
const rows = ref<Row[]>([])
const locations = ref<Ref[]>([])
const positions = ref<Ref[]>([])
const types = ref<Ref[]>([])
const loading = ref(true)
const loadError = ref(false)

function query(): Record<string, string> {
  const q: Record<string, string> = { preset: preset.value }
  for (const [k, v] of Object.entries(filters)) {
    if (k === 'missingOnly') { if (v) q.missingOnly = '1' }
    else if (k === 'status' && preset.value === 'expiring') continue
    else if (v !== '') q[k] = String(v).trim()
  }
  return q
}

async function load() {
  loading.value = true
  loadError.value = false
  try { rows.value = await api<Row[]>('/reports/documents', { query: query() }) }
  catch { loadError.value = true }
  finally { loading.value = false }
}

onMounted(async () => {
  const [l, p, ty] = await Promise.all([
    api<Ref[]>('/refs/locations').catch(() => []),
    api<Ref[]>('/refs/positions').catch(() => []),
    api<Ref[]>('/person-document-types').catch(() => []),
  ])
  locations.value = l
  positions.value = p
  types.value = ty
  await load()
})
watch([preset, () => ({ ...filters })], load, { deep: true })

const exportUrl = (format: 'xlsx' | 'csv') => `/api/v1/reports/documents?${new URLSearchParams({ ...query(), format }).toString()}`
const badge = (s: PersonDocumentStatus | null) => (s === 'valid' ? 'teal' : s === 'expiring' ? 'sun' : s === 'expired' || s === null ? 'coral' : 'muted')
</script>

<template>
  <div>
    <PageHeader :title="t('peopleReports.documents.title')" :subtitle="t('peopleReports.documents.hint')" :crumbs="[{ label: t('admin.group.coreReports') }, { label: t('peopleReports.documents.title') }]" />

    <div class="chips tabs" role="tablist">
      <button type="button" role="tab" :aria-selected="preset === 'all'" :class="['chip', { on: preset === 'all' }]" @click="preset = 'all'">{{ t('peopleReports.documents.tabAll') }}</button>
      <button type="button" role="tab" :aria-selected="preset === 'expiring'" :class="['chip', { on: preset === 'expiring' }]" @click="preset = 'expiring'">{{ t('peopleReports.documents.tabExpiring') }}</button>
    </div>

    <div class="filters">
      <label>{{ t('peopleReports.filter.search') }}
        <input v-model="filters.q" class="field small" type="search" maxlength="100" :placeholder="t('peopleReports.filter.searchPlaceholder')">
      </label>
      <label>{{ t('peopleReports.filter.location') }}
        <select v-model="filters.locationId" class="field small">
          <option value="">{{ t('peopleReports.filter.all') }}</option>
          <option v-for="l in locations" :key="l.id" :value="l.id">{{ l.name }}</option>
        </select>
      </label>
      <label>{{ t('peopleReports.filter.position') }}
        <select v-model="filters.positionId" class="field small">
          <option value="">{{ t('peopleReports.filter.all') }}</option>
          <option v-for="p in positions" :key="p.id" :value="p.id">{{ p.name }}</option>
        </select>
      </label>
      <label>{{ t('peopleReports.documents.type') }}
        <select v-model="filters.typeId" class="field small">
          <option value="">{{ t('peopleReports.filter.all') }}</option>
          <option v-for="ty in types" :key="ty.id" :value="ty.id">{{ ty.name }}</option>
        </select>
      </label>
      <label v-if="preset === 'all' && !filters.missingOnly">{{ t('peopleReports.documents.status') }}
        <select v-model="filters.status" class="field small">
          <option value="">{{ t('peopleReports.documents.statusActive') }}</option>
          <option v-for="s in PERSON_DOCUMENT_STATUSES" :key="s" :value="s">{{ t(`personDocs.status.${s}`) }}</option>
        </select>
      </label>
      <template v-if="!filters.missingOnly">
        <div class="date-label"><label for="docs-from">{{ t('peopleReports.documents.expiresFrom') }}</label>
          <input id="docs-from" v-model="filters.expiresFrom" type="date" class="field small">
        </div>
        <div class="date-label"><label for="docs-to">{{ t('peopleReports.documents.expiresTo') }}</label>
          <input id="docs-to" v-model="filters.expiresTo" type="date" class="field small">
        </div>
      </template>
      <label v-if="preset === 'all'" class="check"><input v-model="filters.missingOnly" type="checkbox"> {{ t('peopleReports.documents.missingOnly') }}</label>
      <span v-if="hasScope('report.export')" class="export">
        <a class="link" :href="exportUrl('xlsx')" download>{{ t('peopleReports.exportXlsx') }}</a>
        <a class="link" :href="exportUrl('csv')" download>{{ t('peopleReports.exportCsv') }}</a>
      </span>
    </div>

    <div v-if="loadError" class="card state" role="alert">
      <p>{{ t('peopleReports.loadError') }}</p>
      <button class="btn ghost small" type="button" @click="load">{{ t('peopleReports.retry') }}</button>
    </div>
    <p v-else-if="loading" class="muted" role="status" aria-busy="true">{{ t('peopleReports.loading') }}</p>
    <div v-else-if="!rows.length" class="card state">{{ filters.missingOnly ? t('peopleReports.documents.emptyMissing') : t('peopleReports.empty') }}</div>
    <div v-else class="table-wrap">
      <table class="table" data-testid="documents-report">
        <thead>
          <tr>
            <th>{{ t('peopleReports.col.person') }}</th>
            <th>{{ t('peopleReports.col.position') }}</th>
            <th>{{ t('peopleReports.col.location') }}</th>
            <th>{{ t('peopleReports.documents.type') }}</th>
            <th>{{ t('peopleReports.documents.status') }}</th>
            <th>{{ t('peopleReports.documents.issuedAt') }}</th>
            <th>{{ t('peopleReports.documents.expiresAt') }}</th>
            <th class="num">{{ t('peopleReports.documents.daysLeft') }}</th>
            <th>{{ t('peopleReports.documents.uploadedBy') }}</th>
          </tr>
        </thead>
        <tbody>
          <tr v-for="r in rows" :key="r.documentId ?? `${r.userId}:${r.typeId}`">
            <td><NuxtLink :to="`/admin/people/${r.userId}`">{{ r.fullName }}</NuxtLink></td>
            <td>{{ r.position ?? '—' }}</td>
            <td>{{ r.location ?? '—' }}</td>
            <td>{{ r.type }}</td>
            <td><span :class="['badge', badge(r.status)]">{{ t(`personDocs.status.${r.status ?? 'missing'}`) }}</span></td>
            <td class="nowrap">{{ r.issuedAt ? formatShortDate(r.issuedAt) : '—' }}</td>
            <td class="nowrap">{{ r.expiresAt ? formatShortDate(r.expiresAt) : '—' }}</td>
            <td class="num">{{ r.daysLeft ?? '—' }}</td>
            <td>{{ r.uploadedBy ?? '—' }}<span v-if="r.selfUploaded" class="sub">{{ t('peopleReports.documents.selfUploaded') }}</span></td>
          </tr>
        </tbody>
      </table>
    </div>
  </div>
</template>

<style scoped>
.tabs { display: flex; flex-wrap: wrap; gap: var(--space-2); margin-bottom: var(--space-3); }
.filters { display: flex; flex-wrap: wrap; gap: var(--space-2); align-items: end; margin-bottom: var(--space-3); }
.filters label, .filters .date-label { display: grid; gap: var(--space-1); font-size: var(--font-size-body-s); color: var(--color-ink-muted); }
.filters .check { display: flex; gap: var(--space-2); align-items: center; }
.export { display: flex; gap: var(--space-3); align-self: center; }
.state { display: grid; gap: var(--space-2); justify-items: start; color: var(--color-ink-muted); }
.sub { display: block; color: var(--color-ink-muted); font-size: var(--font-size-body-s); }
.nowrap { white-space: nowrap; }
@media (max-width: 480px) {
  .filters { flex-direction: column; align-items: stretch; }
}
</style>
