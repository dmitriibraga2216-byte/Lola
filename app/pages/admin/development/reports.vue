<script setup lang="ts">
definePageMeta({ layout: 'admin', middleware: 'admin-scope', requiredScope: 'report.team' })
const { t } = useI18n()
const { api } = useApi()
type Kind = 'gaps' | 'goals' | 'external' | 'promotion'
const kind = ref<Kind>('gaps')
const positions = ref<{ id: string, name: string }[]>([])
const positionId = ref('')
const rows = ref<Record<string, unknown>[]>([])
const profile = ref<{ requirements: number } | null>(null)
const error = ref('')
const loading = ref(false)
async function load() {
  if (kind.value === 'promotion' && !positionId.value) { rows.value = []; return }
  loading.value = true; error.value = ''
  try {
    const r = await api<{ rows?: Record<string, unknown>[], people?: Record<string, unknown>[], profile?: { requirements: number } | null }>('/reports/development', { query: { kind: kind.value, ...(positionId.value ? { positionId: positionId.value } : {}) } })
    rows.value = r.rows ?? r.people ?? []
    profile.value = r.profile ?? null
  }
  catch (err) { error.value = apiErrorOf(err).message }
  finally { loading.value = false }
}
onMounted(async () => { load(); try { positions.value = await api('/refs/positions') } catch { /* пусто */ } })
watch([kind, positionId], load)
</script>
<template>
  <div>
    <h1>{{ t('dev.reports') }}</h1>
    <div class="tabs" role="tablist">
      <button v-for="k in (['gaps', 'goals', 'external', 'promotion'] as Kind[])" :key="k" role="tab" :aria-selected="kind === k" :class="['tab', { on: kind === k }]" @click="kind = k">{{ t(`dev.report.${k}`) }}</button>
    </div>
    <div v-if="kind === 'promotion'" class="row">
      <select v-model="positionId" class="field"><option value="">{{ t('dev.targetPosition') }}</option><option v-for="p in positions" :key="p.id" :value="p.id">{{ p.name }}</option></select>
      <span v-if="profile === null && positionId && !loading" class="sub">{{ t('dev.noProfileForPosition') }}</span>
    </div>
    <p v-if="error" class="error" role="alert">{{ error }}</p>
    <div class="table-wrap">
      <table v-if="kind === 'gaps'" class="table">
        <thead><tr><th>{{ t('dev.competency') }}</th><th>{{ t('dev.peopleTile') }}</th><th>{{ t('dev.withGap') }}</th><th>{{ t('dev.criticalGaps') }}</th><th>{{ t('dev.totalGap') }}</th></tr></thead>
        <tbody><tr v-for="r in rows" :key="String(r.competencyId)"><td><b>{{ r.name }}</b></td><td>{{ r.people }}</td><td>{{ r.withGap }}</td><td :class="{ red: Number(r.critical) > 0 }">{{ r.critical }}</td><td>{{ r.totalGap }}</td></tr></tbody>
      </table>
      <table v-else-if="kind === 'goals'" class="table">
        <thead><tr><th>{{ t('person.location') }}</th><th>{{ t('dev.goalsTotal') }}</th><th>{{ t('dev.achieved') }}</th><th>{{ t('dev.notAchieved') }}</th><th>{{ t('dev.overdue') }}</th><th>{{ t('dev.inProgress') }}</th></tr></thead>
        <tbody><tr v-for="(r, i) in rows" :key="i"><td>{{ r.location }}</td><td>{{ r.total }}</td><td class="teal">{{ r.achieved }}</td><td>{{ r.not_achieved }}</td><td class="red">{{ r.overdue }}</td><td>{{ r.in_progress }}</td></tr></tbody>
      </table>
      <table v-else-if="kind === 'external'" class="table">
        <thead><tr><th>{{ t('person.orgUnit') }}</th><th>{{ t('assign.col.status') }}</th><th>{{ t('dev.requestsN') }}</th><th>{{ t('dev.totalCost') }}</th><th>{{ t('dev.passedAfter') }}</th></tr></thead>
        <tbody><tr v-for="(r, i) in rows" :key="i"><td>{{ r.org_unit }}</td><td>{{ t(`dev.reqStatus.${r.status}`, String(r.status)) }}</td><td>{{ r.requests }}</td><td>{{ r.total_cost }}</td><td>{{ r.passed_after }}</td></tr></tbody>
      </table>
      <table v-else class="table">
        <thead><tr><th>{{ t('people.col.name') }}</th><th>{{ t('person.position') }}</th><th>{{ t('person.location') }}</th><th>{{ t('dev.fitPct') }}</th><th>{{ t('dev.missing') }}</th></tr></thead>
        <tbody><tr v-for="r in rows" :key="String(r.id)"><td><NuxtLink :to="`/admin/people/${r.id}`" class="link">{{ r.full_name }}</NuxtLink></td><td>{{ r.position }}</td><td>{{ r.location }}</td><td><b :class="Number(r.fitPct) === 100 ? 'teal' : ''">{{ r.fitPct }}%</b></td><td>{{ r.missing }}</td></tr></tbody>
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
.row { display: flex; gap: var(--space-2); align-items: center; flex-wrap: wrap; margin-bottom: var(--space-3); }
.field { font: inherit; border: 1px solid var(--color-bg-line); border-radius: var(--radius-s); padding: var(--space-2) var(--space-3); background: var(--color-bg); color: var(--color-ink); }
.table-wrap { overflow-x: auto; }
.table { width: 100%; border-collapse: collapse; background: var(--color-bg-soft); border-radius: var(--radius-m); overflow: hidden; }
th { text-align: left; font-size: var(--font-size-body-s); color: var(--color-ink-muted); padding: var(--space-2) var(--space-3); border-bottom: 1px solid var(--color-bg-line); }
td { padding: var(--space-2) var(--space-3); border-bottom: 1px solid var(--color-bg-line-soft); }
.red { color: var(--color-coral-ink); font-weight: 700; }
.teal { color: var(--color-teal-ink); font-weight: 700; }
.link { color: var(--color-ink); font-weight: 700; text-decoration: none; }
.sub { font-size: var(--font-size-body-s); color: var(--color-ink-faint); }
.error { color: var(--color-coral-ink); }
</style>
