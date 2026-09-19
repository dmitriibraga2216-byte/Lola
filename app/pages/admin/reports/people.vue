<script setup lang="ts">
definePageMeta({ layout: 'admin', middleware: 'admin-scope', requiredScope: 'report.team' })
const { t } = useI18n()
const { api } = useApi()
type Kind = 'staffing' | 'turnover' | 'inactive'
const kind = ref<Kind>('staffing')
const today = new Date().toISOString().slice(0, 10)
const q = reactive({ asOf: today, from: new Date(Date.now() - 30 * 86_400_000).toISOString().slice(0, 10), to: today, days: 30 })
const rows = ref<Record<string, unknown>[]>([])
const error = ref('')
const loading = ref(false)
async function load() {
  loading.value = true
  error.value = ''
  try {
    const r = await api<{ rows: Record<string, unknown>[] }>('/reports/people', { query: { kind: kind.value, asOf: q.asOf, from: q.from, to: q.to, days: q.days } })
    rows.value = r.rows
  }
  catch (err) { error.value = apiErrorOf(err).message }
  finally { loading.value = false }
}
watch([kind, q], load, { deep: true })
onMounted(load)
const fmt = (d: unknown) => d ? new Date(String(d)).toLocaleDateString('uk') : '—'
</script>
<template>
  <div>
    <h1>{{ t('peopleReport.title') }}</h1>
    <div class="tabs" role="tablist">
      <button v-for="k in (['staffing', 'turnover', 'inactive'] as Kind[])" :key="k" role="tab" :aria-selected="kind === k" :class="['tab', { on: kind === k }]" @click="kind = k">{{ t(`peopleReport.${k}`) }}</button>
    </div>
    <div class="filters">
      <label v-if="kind === 'staffing'">{{ t('peopleReport.asOf') }}<input v-model="q.asOf" type="date" :max="today"></label>
      <template v-if="kind === 'turnover'">
        <label>{{ t('peopleReport.from') }}<input v-model="q.from" type="date"></label>
        <label>{{ t('peopleReport.to') }}<input v-model="q.to" type="date"></label>
      </template>
      <label v-if="kind === 'inactive'">{{ t('peopleReport.days') }}<input v-model.number="q.days" type="number" min="1" max="365"></label>
    </div>
    <p v-if="error" class="error" role="alert">{{ error }}</p>
    <p v-if="loading" class="sub">{{ t('common.loading') }}</p>
    <div class="table-wrap">
      <table v-if="kind === 'staffing'" class="table">
        <thead><tr><th>{{ t('peopleReport.location') }}</th><th>{{ t('peopleReport.position') }}</th><th>{{ t('peopleReport.people') }}</th><th>{{ t('peopleReport.newcomers') }}</th><th>{{ t('peopleReport.tenure') }}</th></tr></thead>
        <tbody><tr v-for="(r, i) in rows" :key="i"><td>{{ r.location }}</td><td>{{ r.position }}</td><td><b>{{ r.people }}</b></td><td>{{ r.newcomers }}</td><td class="sub">{{ r.avg_tenure_days }}</td></tr></tbody>
      </table>
      <table v-else-if="kind === 'turnover'" class="table">
        <thead><tr><th>{{ t('peopleReport.location') }}</th><th>{{ t('peopleReport.position') }}</th><th>{{ t('peopleReport.archived') }}</th></tr></thead>
        <tbody><tr v-for="(r, i) in rows" :key="i"><td>{{ r.location }}</td><td>{{ r.position }}</td><td><b>{{ r.archived }}</b></td></tr></tbody>
      </table>
      <table v-else class="table">
        <thead><tr><th>{{ t('peopleReport.name') }}</th><th>{{ t('peopleReport.location') }}</th><th>{{ t('peopleReport.position') }}</th><th>{{ t('peopleReport.lastSeen') }}</th></tr></thead>
        <tbody><tr v-for="r in rows" :key="String(r.id)"><td><NuxtLink :to="`/admin/people/${r.id}`" class="link">{{ r.full_name }}</NuxtLink></td><td>{{ r.location || '—' }}</td><td>{{ r.position || '—' }}</td><td class="sub">{{ fmt(r.last_seen_at) }}</td></tr></tbody>
      </table>
    </div>
    <p v-if="!loading && rows.length === 0" class="sub">{{ t('person.noData') }}</p>
  </div>
</template>
<style scoped>
h1 { margin: 0 0 var(--space-3); font-weight: 900; }
.tabs { display: flex; gap: var(--space-2); margin-bottom: var(--space-3); flex-wrap: wrap; }
.tab { font: inherit; font-weight: 700; border: 1px solid var(--color-bg-line); background: transparent; color: var(--color-ink-muted); border-radius: var(--radius-pill); padding: var(--space-1) var(--space-4); cursor: pointer; }
.tab.on { background: var(--color-ink); border-color: var(--color-ink); color: var(--color-bg-soft); }
.filters { display: flex; gap: var(--space-3); flex-wrap: wrap; margin-bottom: var(--space-3); }
.filters label { display: grid; gap: var(--space-1); font-size: var(--font-size-body-s); color: var(--color-ink-muted); }
input { font: inherit; border: 1px solid var(--color-bg-line); border-radius: var(--radius-s); padding: var(--space-1) var(--space-2); background: var(--color-bg); color: var(--color-ink); }
.table-wrap { overflow-x: auto; }
.table { width: 100%; border-collapse: collapse; background: var(--color-bg-soft); border-radius: var(--radius-m); overflow: hidden; }
th { text-align: left; font-size: var(--font-size-body-s); color: var(--color-ink-muted); padding: var(--space-2) var(--space-3); border-bottom: 1px solid var(--color-bg-line); }
td { padding: var(--space-2) var(--space-3); border-bottom: 1px solid var(--color-bg-line-soft); }
.sub { color: var(--color-ink-faint); font-size: var(--font-size-body-s); }
.link { color: var(--color-ink); font-weight: 700; text-decoration: none; }
.error { color: var(--color-coral-ink); }
</style>
