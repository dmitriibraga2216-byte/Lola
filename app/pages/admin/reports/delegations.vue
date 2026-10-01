<script setup lang="ts">
/**
 * Журнал «Делегування» — `/admin/reports/delegations` (docs/v2/37 §9.4; API `/reports/delegations`).
 *
 * Строка — одна передача проверки: Дата · Від кого · Кому · Глибина · Завдання · Причина ·
 * Пояснення · Стан · Дата завершення. Фильтры §9.4: період, від кого, кому, причина, стан; сверх
 * них — точка. Кого показывать, решает сервер (область роли, кандидаты — по `candidate.view`).
 * На узком экране таблица прокручивается в своей рамке, фильтры встают столбиком.
 */
import { REVIEW_DELEGATION_REASONS, REVIEW_DELEGATION_STATES } from '#shared/enums'
import type { ReviewDelegationReason, ReviewDelegationState, ReviewTaskType } from '#shared/enums'

definePageMeta({ layout: 'admin', middleware: 'admin-scope', requiredScope: 'review.workload.view' })

const { t } = useI18n()
const { api } = useApi()
const { hasScope } = useAuth()
const { formatDateTime } = useFormat()

interface Row {
  id: string
  createdAt: string
  fromName: string | null
  toName: string | null
  depth: number
  taskType: ReviewTaskType
  taskTitle: string | null
  locationName: string | null
  reasonCode: ReviewDelegationReason
  reasonText: string | null
  state: ReviewDelegationState
  resolvedAt: string | null
}
interface Person { userId: string, fullName: string }
interface Location { id: string, name: string }

const filters = reactive({ from: '', to: '', fromUserId: '', toUserId: '', reasonCode: '', state: '', locationId: '' })
const rows = ref<Row[]>([])
const truncated = ref(false)
const people = ref<Person[]>([])
const locations = ref<Location[]>([])
const loading = ref(true)
const loadError = ref(false)

function query(): Record<string, string> {
  return Object.fromEntries(Object.entries(filters).filter(([, v]) => v !== '')) as Record<string, string>
}

async function load() {
  loading.value = true
  loadError.value = false
  try {
    const r = await api<{ rows: Row[], truncated: boolean }>('/reports/delegations', { query: query() })
    rows.value = r.rows
    truncated.value = r.truncated
  }
  catch {
    loadError.value = true
  }
  finally {
    loading.value = false
  }
}

onMounted(async () => {
  const [p, l] = await Promise.all([
    api<Person[]>('/review/workload').catch(() => []),
    api<Location[]>('/refs/locations').catch(() => []),
  ])
  people.value = p
  locations.value = l
  await load()
})
watch(() => ({ ...filters }), load, { deep: true })

const exportUrl = computed(() => `/api/v1/reports/delegations?${new URLSearchParams({ ...query(), format: 'xlsx' }).toString()}`)
const stateBadge = (s: ReviewDelegationState) => (s === 'active' ? 'sun' : s === 'resolved' ? 'teal' : s === 'revoked_sla' ? 'coral' : 'muted')
</script>

<template>
  <div>
    <PageHeader :title="t('delegationJournal.title')" :subtitle="t('delegationJournal.hint')" :crumbs="[{ label: t('admin.group.review') }, { label: t('delegationJournal.title') }]" />

    <div class="filters">
      <div class="date-label"><label for="dj-from">{{ t('delegationJournal.filter.from') }}</label>
        <input id="dj-from" v-model="filters.from" type="date" class="field small">
      </div>
      <div class="date-label"><label for="dj-to">{{ t('delegationJournal.filter.to') }}</label>
        <input id="dj-to" v-model="filters.to" type="date" class="field small">
      </div>
      <label>{{ t('delegationJournal.filter.fromUser') }}
        <select v-model="filters.fromUserId" class="field small">
          <option value="">{{ t('delegationJournal.filter.anyone') }}</option>
          <option v-for="p in people" :key="p.userId" :value="p.userId">{{ p.fullName }}</option>
        </select>
      </label>
      <label>{{ t('delegationJournal.filter.toUser') }}
        <select v-model="filters.toUserId" class="field small">
          <option value="">{{ t('delegationJournal.filter.anyone') }}</option>
          <option v-for="p in people" :key="p.userId" :value="p.userId">{{ p.fullName }}</option>
        </select>
      </label>
      <label>{{ t('delegationJournal.filter.reason') }}
        <select v-model="filters.reasonCode" class="field small">
          <option value="">{{ t('delegationJournal.filter.all') }}</option>
          <option v-for="r in REVIEW_DELEGATION_REASONS" :key="r" :value="r">{{ t(`reviewDelegate.reasons.${r}`) }}</option>
        </select>
      </label>
      <label>{{ t('delegationJournal.filter.state') }}
        <select v-model="filters.state" class="field small">
          <option value="">{{ t('delegationJournal.filter.all') }}</option>
          <option v-for="s in REVIEW_DELEGATION_STATES" :key="s" :value="s">{{ t(`reviewQueue.delegationState.${s}`) }}</option>
        </select>
      </label>
      <label>{{ t('delegationJournal.filter.location') }}
        <select v-model="filters.locationId" class="field small">
          <option value="">{{ t('delegationJournal.filter.all') }}</option>
          <option v-for="l in locations" :key="l.id" :value="l.id">{{ l.name }}</option>
        </select>
      </label>
      <a v-if="hasScope('report.export')" :href="exportUrl" class="link export">{{ t('delegationJournal.export') }}</a>
    </div>

    <div v-if="loadError" class="card state" role="alert">
      <p>{{ t('delegationJournal.loadError') }}</p>
      <button class="btn ghost small" type="button" @click="load">{{ t('reviewQueue.retry') }}</button>
    </div>
    <div v-else-if="loading" class="skeleton" :aria-label="t('reviewQueue.loading')" role="status">
      <div v-for="n in 6" :key="n" class="bar" />
    </div>
    <div v-else-if="!rows.length" class="card state">{{ t('delegationJournal.empty') }}</div>
    <div v-else class="table-wrap">
      <table class="table">
        <thead>
          <tr>
            <th>{{ t('delegationJournal.col.date') }}</th>
            <th>{{ t('delegationJournal.col.from') }}</th>
            <th>{{ t('delegationJournal.col.to') }}</th>
            <th class="num">{{ t('delegationJournal.col.depth') }}</th>
            <th>{{ t('delegationJournal.col.task') }}</th>
            <th>{{ t('delegationJournal.col.reason') }}</th>
            <th>{{ t('delegationJournal.col.reasonText') }}</th>
            <th>{{ t('delegationJournal.col.state') }}</th>
            <th>{{ t('delegationJournal.col.resolvedAt') }}</th>
          </tr>
        </thead>
        <tbody>
          <tr v-for="r in rows" :key="r.id">
            <td class="nowrap">{{ formatDateTime(r.createdAt) }}</td>
            <td>{{ r.fromName ?? '—' }}</td>
            <td>{{ r.toName ?? '—' }}</td>
            <td class="num">{{ r.depth }}</td>
            <td>
              {{ r.taskTitle ?? t(`reviewQueue.taskType.${r.taskType}`) }}
              <span class="sub">{{ t(`reviewQueue.taskType.${r.taskType}`) }}<template v-if="r.locationName"> · {{ r.locationName }}</template></span>
            </td>
            <td>{{ t(`reviewDelegate.reasons.${r.reasonCode}`) }}</td>
            <td>{{ r.reasonText ?? '—' }}</td>
            <td><span :class="['badge', stateBadge(r.state)]">{{ t(`reviewQueue.delegationState.${r.state}`) }}</span></td>
            <td class="nowrap">{{ r.resolvedAt ? formatDateTime(r.resolvedAt) : '—' }}</td>
          </tr>
        </tbody>
      </table>
      <p v-if="truncated" class="sub">{{ t('delegationJournal.truncated', { n: rows.length }) }}</p>
    </div>
  </div>
</template>

<style scoped>
.filters { display: flex; flex-wrap: wrap; gap: var(--space-2); align-items: end; margin-bottom: var(--space-3); }
.filters label, .filters .date-label { display: grid; gap: var(--space-1); font-size: var(--font-size-body-s); color: var(--color-ink-muted); }
.export { align-self: center; }
.state { display: grid; gap: var(--space-2); justify-items: start; color: var(--color-ink-muted); }
.skeleton { display: grid; gap: var(--space-2); }
.skeleton .bar { height: var(--space-6); border-radius: var(--radius-s); background: var(--color-bg-line-soft); }
.sub { display: block; color: var(--color-ink-muted); font-size: var(--font-size-body-s); }
.nowrap { white-space: nowrap; }
@media (max-width: 480px) {
  .filters { flex-direction: column; align-items: stretch; }
}
</style>
