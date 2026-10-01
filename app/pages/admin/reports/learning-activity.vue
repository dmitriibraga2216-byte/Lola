<script setup lang="ts">
/**
 * «Навчальна активність» — `/admin/reports/learning-activity` (docs/v2/38 §9 п. 4; API
 * `/reports/learning-activity`). ПІБ · Точка · Днів з активністю · Найдовша серія · Усього подій ·
 * Годин за произвольный период по `user_activity_daily`; по умолчанию — последние 30 дней.
 * На узком экране фильтры встают столбиком, таблица прокручивается в своей рамке.
 */
definePageMeta({ layout: 'admin', middleware: 'admin-scope', requiredScope: 'person.activity.view_others' })

interface Row { userId: string, fullName: string, location: string | null, daysActive: number, longestStreak: number, totalEvents: number, hours: number }
interface Ref { id: string, name: string }

const { t } = useI18n()
const { api } = useApi()
const { hasScope } = useAuth()
const { formatNumber } = useFormat()

const iso = (d: Date) => `${d.getFullYear()}-${String(d.getMonth() + 1).padStart(2, '0')}-${String(d.getDate()).padStart(2, '0')}`
const today = new Date()
const filters = reactive({ from: iso(new Date(today.getTime() - 29 * 86_400_000)), to: iso(today), locationId: '', q: '' })
const rows = ref<Row[]>([])
const locations = ref<Ref[]>([])
const loading = ref(true)
const loadError = ref(false)
const badRange = computed(() => !!filters.from && !!filters.to && filters.from > filters.to)

function query(): Record<string, string> {
  return Object.fromEntries(Object.entries(filters).map(([k, v]) => [k, v.trim()]).filter(([, v]) => v !== '')) as Record<string, string>
}

async function load() {
  if (badRange.value) return
  loading.value = true
  loadError.value = false
  try { rows.value = await api<Row[]>('/reports/learning-activity', { query: query() }) }
  catch { loadError.value = true }
  finally { loading.value = false }
}

onMounted(async () => {
  locations.value = await api<Ref[]>('/refs/locations').catch(() => [])
  await load()
})
watch(() => ({ ...filters }), load, { deep: true })

const exportUrl = (format: 'xlsx' | 'csv') => `/api/v1/reports/learning-activity?${new URLSearchParams({ ...query(), format }).toString()}`
</script>

<template>
  <div>
    <PageHeader :title="t('peopleReports.activity.title')" :subtitle="t('peopleReports.activity.hint')" :crumbs="[{ label: t('admin.group.coreReports') }, { label: t('peopleReports.activity.title') }]" />

    <div class="filters">
      <label>{{ t('peopleReports.filter.search') }}
        <input v-model="filters.q" class="field small" type="search" maxlength="100" :placeholder="t('peopleReports.filter.searchPlaceholder')">
      </label>
      <div class="date-label"><label for="act-from">{{ t('peopleReports.activity.from') }}</label>
        <input id="act-from" v-model="filters.from" type="date" class="field small">
      </div>
      <div class="date-label"><label for="act-to">{{ t('peopleReports.activity.to') }}</label>
        <input id="act-to" v-model="filters.to" type="date" class="field small">
      </div>
      <label>{{ t('peopleReports.filter.location') }}
        <select v-model="filters.locationId" class="field small">
          <option value="">{{ t('peopleReports.filter.all') }}</option>
          <option v-for="l in locations" :key="l.id" :value="l.id">{{ l.name }}</option>
        </select>
      </label>
      <span v-if="hasScope('report.export') && !badRange" class="export">
        <a class="link" :href="exportUrl('xlsx')" download>{{ t('peopleReports.exportXlsx') }}</a>
        <a class="link" :href="exportUrl('csv')" download>{{ t('peopleReports.exportCsv') }}</a>
      </span>
    </div>

    <p v-if="badRange" class="note coral" role="alert">{{ t('peopleReports.activity.badRange') }}</p>
    <div v-else-if="loadError" class="card state" role="alert">
      <p>{{ t('peopleReports.loadError') }}</p>
      <button class="btn ghost small" type="button" @click="load">{{ t('peopleReports.retry') }}</button>
    </div>
    <p v-else-if="loading" class="muted" role="status" aria-busy="true">{{ t('peopleReports.loading') }}</p>
    <div v-else-if="!rows.length" class="card state">{{ t('peopleReports.empty') }}</div>
    <div v-else class="table-wrap">
      <table class="table" data-testid="activity-report">
        <thead>
          <tr>
            <th>{{ t('peopleReports.col.person') }}</th>
            <th>{{ t('peopleReports.col.location') }}</th>
            <th class="num">{{ t('peopleReports.activity.daysActive') }}</th>
            <th class="num">{{ t('peopleReports.activity.longestStreak') }}</th>
            <th class="num">{{ t('peopleReports.activity.totalEvents') }}</th>
            <th class="num">{{ t('peopleReports.activity.hours') }}</th>
          </tr>
        </thead>
        <tbody>
          <tr v-for="r in rows" :key="r.userId">
            <td><NuxtLink :to="`/admin/people/${r.userId}`">{{ r.fullName }}</NuxtLink></td>
            <td>{{ r.location ?? '—' }}</td>
            <td class="num">{{ r.daysActive }}</td>
            <td class="num">{{ r.longestStreak }}</td>
            <td class="num">{{ r.totalEvents }}</td>
            <td class="num">{{ formatNumber(r.hours, { maximumFractionDigits: 1 }) }}</td>
          </tr>
        </tbody>
      </table>
    </div>
  </div>
</template>

<style scoped>
.filters { display: flex; flex-wrap: wrap; gap: var(--space-2); align-items: end; margin-bottom: var(--space-3); }
.filters label, .filters .date-label { display: grid; gap: var(--space-1); font-size: var(--font-size-body-s); color: var(--color-ink-muted); }
.export { display: flex; gap: var(--space-3); align-self: center; }
.state { display: grid; gap: var(--space-2); justify-items: start; color: var(--color-ink-muted); }
@media (max-width: 480px) {
  .filters { flex-direction: column; align-items: stretch; }
}
</style>
