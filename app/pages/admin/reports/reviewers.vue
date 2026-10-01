<script setup lang="ts">
/**
 * «Робота перевіряючих» — `/admin/reports/reviewers` (docs/v2/37 §9.2; API `/reports/reviewers`).
 *
 * Строка — проверяющий за период, колонки §9.2 в их порядке. Фильтры §9.2: період, філія, тип
 * завдання, тип суб'єкта. Без периода сервер берёт последние 30 суток и возвращает, какой период
 * посчитан, — он подписан над таблицей. Считает сервер (CLAUDE.md п. 3): доли и медианы приходят
 * готовыми, экран их только форматирует. На узком экране фильтры встают столбиком, таблица
 * прокручивается в своей рамке.
 */
import { REVIEW_TASK_TYPES } from '#shared/enums'

definePageMeta({ layout: 'admin', middleware: 'admin-scope', requiredScope: 'review.workload.view' })

const { t } = useI18n()
const { api } = useApi()
const { hasScope } = useAuth()
const { formatDate, formatNumber } = useFormat()

interface Row {
  reviewerId: string
  reviewerName: string
  locations: string[]
  reviewed: number
  accepted: number
  rejected: number
  rework: number
  acceptedShare: number | null
  medianReactSec: number | null
  medianReviewSec: number | null
  delegatedOut: number
  delegatedIn: number
  delegatedShare: number | null
  breached: number
  escalated: number
  ownContent: number
}
interface Location { id: string, name: string }

const filters = reactive({ from: '', to: '', locationId: '', taskType: '', subjectKind: '' })
const rows = ref<Row[]>([])
const period = ref<{ from: string, to: string } | null>(null)
const locations = ref<Location[]>([])
const loading = ref(true)
const loadError = ref(false)
const badDates = computed(() => !!filters.from && !!filters.to && filters.from > filters.to)

function query(): Record<string, string> {
  return Object.fromEntries(Object.entries(filters).filter(([, v]) => v !== '')) as Record<string, string>
}

async function load() {
  if (badDates.value) return
  loading.value = true
  loadError.value = false
  try {
    const r = await api<{ rows: Row[], from: string, to: string }>('/reports/reviewers', { query: query() })
    rows.value = r.rows
    period.value = { from: r.from, to: r.to }
  }
  catch {
    loadError.value = true
  }
  finally {
    loading.value = false
  }
}

onMounted(async () => {
  locations.value = await api<Location[]>('/refs/locations').catch(() => [])
  await load()
})
watch(() => ({ ...filters }), load, { deep: true })

const exportUrl = computed(() => `/api/v1/reports/reviewers?${new URLSearchParams({ ...query(), format: 'xlsx' }).toString()}`)
const pct = (v: number | null) => (v === null ? '—' : formatNumber(v, { style: 'percent', maximumFractionDigits: 1 }))
function duration(sec: number | null): string {
  if (sec === null) return '—'
  const m = Math.round(sec / 60)
  return m < 60 ? t('reviewerReport.minutes', { m }) : t('reviewerReport.hours', { h: Math.floor(m / 60), m: m % 60 })
}
</script>

<template>
  <div>
    <PageHeader :title="t('reviewerReport.title')" :subtitle="t('reviewerReport.hint')" :crumbs="[{ label: t('admin.group.review') }, { label: t('reviewerReport.title') }]" />

    <div class="filters">
      <div class="date-label"><label for="rr-from">{{ t('reviewQueue.filter.from') }}</label>
        <input id="rr-from" v-model="filters.from" type="date" class="field small" :aria-invalid="badDates">
      </div>
      <div class="date-label"><label for="rr-to">{{ t('reviewQueue.filter.to') }}</label>
        <input id="rr-to" v-model="filters.to" type="date" class="field small" :aria-invalid="badDates" aria-describedby="rr-dates-error">
      </div>
      <label>{{ t('reviewQueue.filter.location') }}
        <select v-model="filters.locationId" class="field small">
          <option value="">{{ t('reviewQueue.filter.allLocations') }}</option>
          <option v-for="l in locations" :key="l.id" :value="l.id">{{ l.name }}</option>
        </select>
      </label>
      <label>{{ t('reviewQueue.filter.taskType') }}
        <select v-model="filters.taskType" class="field small">
          <option value="">{{ t('reviewQueue.filter.allTaskTypes') }}</option>
          <option v-for="tt in REVIEW_TASK_TYPES" :key="tt" :value="tt">{{ t(`reviewQueue.taskType.${tt}`) }}</option>
        </select>
      </label>
      <label>{{ t('reviewQueue.filter.subjectKind') }}
        <select v-model="filters.subjectKind" class="field small">
          <option value="">{{ t('reviewQueue.filter.subjectAll') }}</option>
          <option value="employee">{{ t('reviewQueue.filter.subjectEmployee') }}</option>
          <option v-if="hasScope('candidate.view')" value="candidate">{{ t('reviewQueue.filter.subjectCandidate') }}</option>
        </select>
      </label>
      <a v-if="hasScope('report.export') && !badDates" :href="exportUrl" class="link export">{{ t('reviewerReport.export') }}</a>
    </div>
    <p v-if="badDates" id="rr-dates-error" class="error" role="alert">{{ t('reviewerReport.badDates') }}</p>
    <p v-else-if="period" class="sub period">{{ t('reviewerReport.period', { from: formatDate(period.from), to: formatDate(period.to) }) }}</p>

    <div v-if="loadError" class="card state" role="alert">
      <p>{{ t('reviewerReport.loadError') }}</p>
      <button class="btn ghost small" type="button" @click="load">{{ t('reviewQueue.retry') }}</button>
    </div>
    <div v-else-if="loading" class="skeleton" :aria-label="t('reviewQueue.loading')" role="status">
      <div v-for="n in 6" :key="n" class="bar" />
    </div>
    <div v-else-if="!rows.length" class="card state">{{ t('reviewerReport.empty') }}</div>
    <div v-else class="table-wrap" tabindex="0" :aria-label="t('reviewerReport.title')">
      <table class="table">
        <thead>
          <tr>
            <th>{{ t('reviewerReport.col.reviewer') }}</th>
            <th>{{ t('reviewerReport.col.locations') }}</th>
            <th class="num">{{ t('reviewerReport.col.reviewed') }}</th>
            <th class="num">{{ t('reviewerReport.col.accepted') }}</th>
            <th class="num">{{ t('reviewerReport.col.rejected') }}</th>
            <th class="num">{{ t('reviewerReport.col.rework') }}</th>
            <th class="num">{{ t('reviewerReport.col.acceptedShare') }}</th>
            <th class="num">{{ t('reviewerReport.col.medianReact') }}</th>
            <th class="num">{{ t('reviewerReport.col.medianReview') }}</th>
            <th class="num">{{ t('reviewerReport.col.delegatedOut') }}</th>
            <th class="num">{{ t('reviewerReport.col.delegatedIn') }}</th>
            <th class="num">{{ t('reviewerReport.col.delegatedShare') }}</th>
            <th class="num">{{ t('reviewerReport.col.breached') }}</th>
            <th class="num">{{ t('reviewerReport.col.escalated') }}</th>
            <th class="num">{{ t('reviewerReport.col.ownContent') }}</th>
          </tr>
        </thead>
        <tbody>
          <tr v-for="r in rows" :key="r.reviewerId">
            <td>{{ r.reviewerName }}</td>
            <td>{{ r.locations.length ? r.locations.join(', ') : '—' }}</td>
            <td class="num">{{ r.reviewed }}</td>
            <td class="num">{{ r.accepted }}</td>
            <td class="num">{{ r.rejected }}</td>
            <td class="num">{{ r.rework }}</td>
            <td class="num">{{ pct(r.acceptedShare) }}</td>
            <td class="num nowrap">{{ duration(r.medianReactSec) }}</td>
            <td class="num nowrap">{{ duration(r.medianReviewSec) }}</td>
            <td class="num">{{ r.delegatedOut }}</td>
            <td class="num">{{ r.delegatedIn }}</td>
            <td class="num">{{ pct(r.delegatedShare) }}</td>
            <td class="num"><span :class="{ 'badge coral': r.breached > 0 }">{{ r.breached }}</span></td>
            <td class="num">{{ r.escalated }}</td>
            <td class="num">{{ r.ownContent }}</td>
          </tr>
        </tbody>
      </table>
    </div>
  </div>
</template>

<style scoped>
.filters { display: flex; flex-wrap: wrap; gap: var(--space-2); align-items: end; margin-bottom: var(--space-3); }
.filters label, .filters .date-label { display: grid; gap: var(--space-1); font-size: var(--font-size-body-s); color: var(--color-ink-muted); }
.export { align-self: center; }
.period { margin-bottom: var(--space-2); }
.error { color: var(--color-coral-ink); margin-bottom: var(--space-2); }
.state { display: grid; gap: var(--space-2); justify-items: start; color: var(--color-ink-muted); }
.skeleton { display: grid; gap: var(--space-2); }
.skeleton .bar { height: var(--space-6); border-radius: var(--radius-s); background: var(--color-bg-line-soft); }
.sub { display: block; color: var(--color-ink-muted); font-size: var(--font-size-body-s); }
.nowrap { white-space: nowrap; }
@media (max-width: 480px) {
  .filters { flex-direction: column; align-items: stretch; }
}
</style>
