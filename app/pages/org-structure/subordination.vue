<script setup lang="ts">
/**
 * «Підпорядкування людей» — `/org-structure/subordination` (docs/v2/32 §9, `v2/44` Р-OS.6):
 * ПІБ · Посада · Філія · Вузол · Керівник · Джерело керівника · Сумісництва · Дата початку.
 * Фильтр «лише резервні правила» — у кого подчинение держится не на дереве (`source ≠ org_tree`).
 */
definePageMeta({ layout: 'admin', middleware: 'admin-scope', requiredScope: 'report.team' })

interface Row {
  userId: string, fullName: string, position: string | null, location: string | null, node: string | null
  managerUserId: string | null, manager: string | null, source: string | null, secondary: string[], since: string | null
}

const { t } = useI18n()
const { api } = useApi()
const { hasScope } = useAuth()
const { formatShortDate } = useFormat()

const filters = reactive({ q: '', locationId: '', onlyFallback: false })
const locations = ref<{ id: string, name: string }[]>([])
const rows = ref<Row[] | null>(null)
const error = ref(false)
const busy = ref(false)

const query = (): Record<string, string> => ({
  ...(filters.q.trim() ? { q: filters.q.trim() } : {}),
  ...(filters.locationId ? { locationId: filters.locationId } : {}),
  ...(filters.onlyFallback ? { onlyFallback: '1' } : {}),
})

async function load() {
  busy.value = true
  error.value = false
  rows.value = null
  try { rows.value = await api<Row[]>('/org-structure/subordination', { query: query() }) }
  catch { error.value = true }
  finally { busy.value = false }
}
onMounted(async () => {
  locations.value = await api<{ id: string, name: string }[]>('/refs/locations').catch(() => [])
  await load()
})

const exportUrl = (format: 'xlsx' | 'csv') => `/api/v1/org-structure/subordination?${new URLSearchParams({ ...query(), format }).toString()}`
const sourceOf = (s: string | null) => t(`orgReports.source.${s ?? 'unknown'}`)
</script>

<template>
  <div>
    <PageHeader :title="t('orgReports.subordination.title')" :subtitle="t('orgReports.subordination.hint')" :crumbs="[{ label: t('orgStructure.title'), to: '/org-structure' }]" />

    <form class="filters" @submit.prevent="load">
      <label>{{ t('orgReports.search') }} <input v-model="filters.q" class="field" type="search" :placeholder="t('orgReports.subordination.searchPlaceholder')"></label>
      <label>{{ t('orgReports.col.location') }}
        <select v-model="filters.locationId" class="field">
          <option value="">{{ t('orgStructure.allOption') }}</option>
          <option v-for="l in locations" :key="l.id" :value="l.id">{{ l.name }}</option>
        </select>
      </label>
      <label class="check"><input v-model="filters.onlyFallback" type="checkbox"> {{ t('orgReports.subordination.onlyFallback') }}</label>
      <button class="btn primary" type="submit" :disabled="busy">{{ t('orgReports.apply') }}</button>
    </form>

    <div v-if="hasScope('report.export')" class="export">
      <a class="btn ghost" :href="exportUrl('xlsx')" download>{{ t('orgReports.exportXlsx') }}</a>
      <a class="btn ghost" :href="exportUrl('csv')" download>{{ t('orgReports.exportCsv') }}</a>
    </div>

    <div v-if="error" class="note coral" role="alert">
      {{ t('orgReports.loadError') }}
      <button type="button" class="btn ghost" @click="load">{{ t('orgReports.retry') }}</button>
    </div>
    <p v-else-if="!rows" class="muted" aria-busy="true">{{ t('orgReports.loading') }}</p>
    <p v-else-if="rows.length === 0" class="muted">{{ t('orgReports.subordination.empty') }}</p>
    <div v-else class="table-wrap">
      <table class="table">
        <thead>
          <tr>
            <th>{{ t('orgReports.col.person') }}</th>
            <th>{{ t('orgReports.col.position') }}</th>
            <th>{{ t('orgReports.col.location') }}</th>
            <th>{{ t('orgReports.col.node') }}</th>
            <th>{{ t('orgReports.col.manager') }}</th>
            <th>{{ t('orgReports.col.source') }}</th>
            <th>{{ t('orgReports.col.secondary') }}</th>
            <th>{{ t('orgReports.col.since') }}</th>
          </tr>
        </thead>
        <tbody>
          <tr v-for="r in rows" :key="r.userId">
            <td><NuxtLink :to="`/admin/people/${r.userId}`">{{ r.fullName }}</NuxtLink></td>
            <td>{{ r.position ?? '—' }}</td>
            <td>{{ r.location ?? '—' }}</td>
            <td>{{ r.node ?? '—' }}</td>
            <td>{{ r.manager ?? '—' }}</td>
            <td><span :class="['badge', r.source === 'org_tree' ? 'teal' : 'sun']">{{ sourceOf(r.source) }}</span></td>
            <td>{{ r.secondary.length ? r.secondary.join(', ') : '—' }}</td>
            <td class="nowrap">{{ r.since ? formatShortDate(r.since) : '—' }}</td>
          </tr>
        </tbody>
      </table>
    </div>
  </div>
</template>

<style scoped>
.filters { display: flex; flex-wrap: wrap; gap: var(--space-2); align-items: end; margin-bottom: var(--space-3); }
.filters label { display: grid; gap: var(--space-1); font-size: var(--font-size-body-s); font-weight: 700; min-width: 0; }
.filters .check { display: flex; align-items: center; gap: var(--space-2); font-weight: 400; }
.filters .field { width: auto; min-width: 180px; padding: var(--space-2) var(--space-3); }
.export { display: flex; flex-wrap: wrap; gap: var(--space-2); margin-bottom: var(--space-3); }
.nowrap { white-space: nowrap; }
@media (max-width: 480px) {
  .filters { flex-direction: column; align-items: stretch; }
  .filters .field { width: 100%; min-width: 0; }
}
</style>
