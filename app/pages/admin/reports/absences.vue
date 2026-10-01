<script setup lang="ts">
/**
 * «Норми і залишки відсутностей» — `/admin/reports/absences` (docs/v2/38 §9 п. 3; API
 * `/reports/absences`). Строка — человек × вид с нормой: ПІБ · Точка · Вид · Норма · Джерело норми ·
 * Використано · Залишок; цифры — те же, что в блоке «Відсутності» карточки. Отрицательный остаток —
 * коралловым, фильтр «Тільки відʼємний залишок». На узком экране таблица прокручивается в своей рамке.
 */
import type { AbsenceNormKind } from '#shared/enums'

definePageMeta({ layout: 'admin', middleware: 'admin-scope', requiredScope: 'person.absence.manage' })

interface Row { userId: string, fullName: string, location: string | null, kind: AbsenceNormKind, norm: number, normSource: 'tenant' | 'location' | 'user' | 'system', used: number, remaining: number }
interface Ref { id: string, name: string }

const { t } = useI18n()
const { api } = useApi()
const { hasScope } = useAuth()
const { formatNumber } = useFormat()

const thisYear = new Date().getFullYear()
const filters = reactive({ year: String(thisYear), locationId: '', negativeOnly: false, q: '' })
const rows = ref<Row[]>([])
const locations = ref<Ref[]>([])
const loading = ref(true)
const loadError = ref(false)

function query(): Record<string, string> {
  const q: Record<string, string> = {}
  if (filters.year) q.year = filters.year
  if (filters.locationId) q.locationId = filters.locationId
  if (filters.negativeOnly) q.negativeOnly = '1'
  if (filters.q.trim()) q.q = filters.q.trim()
  return q
}

async function load() {
  loading.value = true
  loadError.value = false
  try { rows.value = await api<Row[]>('/reports/absences', { query: query() }) }
  catch { loadError.value = true }
  finally { loading.value = false }
}

onMounted(async () => {
  locations.value = await api<Ref[]>('/refs/locations').catch(() => [])
  await load()
})
watch(() => ({ ...filters }), load, { deep: true })

const exportUrl = (format: 'xlsx' | 'csv') => `/api/v1/reports/absences?${new URLSearchParams({ ...query(), format }).toString()}`
const days = (v: number) => formatNumber(v, { maximumFractionDigits: 1 })
const years = [thisYear + 1, thisYear, thisYear - 1, thisYear - 2]
</script>

<template>
  <div>
    <PageHeader :title="t('peopleReports.absences.title')" :subtitle="t('peopleReports.absences.hint')" :crumbs="[{ label: t('admin.group.coreReports') }, { label: t('peopleReports.absences.title') }]" />

    <div class="filters">
      <label>{{ t('peopleReports.filter.search') }}
        <input v-model="filters.q" class="field small" type="search" maxlength="100" :placeholder="t('peopleReports.filter.searchPlaceholder')">
      </label>
      <label>{{ t('peopleReports.absences.year') }}
        <select v-model="filters.year" class="field small">
          <option v-for="y in years" :key="y" :value="String(y)">{{ y }}</option>
        </select>
      </label>
      <label>{{ t('peopleReports.filter.location') }}
        <select v-model="filters.locationId" class="field small">
          <option value="">{{ t('peopleReports.filter.all') }}</option>
          <option v-for="l in locations" :key="l.id" :value="l.id">{{ l.name }}</option>
        </select>
      </label>
      <label class="check"><input v-model="filters.negativeOnly" type="checkbox"> {{ t('peopleReports.absences.negativeOnly') }}</label>
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
    <div v-else-if="!rows.length" class="card state">{{ filters.negativeOnly ? t('peopleReports.absences.emptyNegative') : t('peopleReports.empty') }}</div>
    <div v-else class="table-wrap">
      <table class="table" data-testid="absences-report">
        <thead>
          <tr>
            <th>{{ t('peopleReports.col.person') }}</th>
            <th>{{ t('peopleReports.col.location') }}</th>
            <th>{{ t('peopleReports.absences.kind') }}</th>
            <th class="num">{{ t('peopleReports.absences.norm') }}</th>
            <th>{{ t('peopleReports.absences.source') }}</th>
            <th class="num">{{ t('peopleReports.absences.used') }}</th>
            <th class="num">{{ t('peopleReports.absences.remaining') }}</th>
          </tr>
        </thead>
        <tbody>
          <tr v-for="r in rows" :key="`${r.userId}:${r.kind}`">
            <td><NuxtLink :to="`/admin/people/${r.userId}`">{{ r.fullName }}</NuxtLink></td>
            <td>{{ r.location ?? '—' }}</td>
            <td>{{ t(`absence.kind.${r.kind}`) }}</td>
            <td class="num">{{ days(r.norm) }}</td>
            <td>{{ t(`peopleReports.absences.sources.${r.normSource}`) }}</td>
            <td class="num">{{ days(r.used) }}</td>
            <td :class="['num', { negative: r.remaining < 0 }]">{{ days(r.remaining) }}</td>
          </tr>
        </tbody>
      </table>
    </div>
  </div>
</template>

<style scoped>
.filters { display: flex; flex-wrap: wrap; gap: var(--space-2); align-items: end; margin-bottom: var(--space-3); }
.filters label { display: grid; gap: var(--space-1); font-size: var(--font-size-body-s); color: var(--color-ink-muted); }
.filters .check { display: flex; gap: var(--space-2); align-items: center; }
.export { display: flex; gap: var(--space-3); align-self: center; }
.state { display: grid; gap: var(--space-2); justify-items: start; color: var(--color-ink-muted); }
.negative { color: var(--color-coral-ink); font-weight: 700; }
@media (max-width: 480px) {
  .filters { flex-direction: column; align-items: stretch; }
}
</style>
