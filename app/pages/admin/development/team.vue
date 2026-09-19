<script setup lang="ts">
definePageMeta({ layout: 'admin', middleware: 'admin-scope', requiredScope: 'development.team' })
const { t } = useI18n()
const { api } = useApi()
interface G { id: string, title: string, kind: string, due_at: string, status_code: string, status_name: string, status_color: string, is_final: boolean, progress_pct: number, user_id: string, full_name: string, location: string | null, is_overdue: boolean }
interface Status { code: string, name: string }
const items = ref<G[]>([])
const statuses = ref<Status[]>([])
const filter = reactive({ status: '', overdue: false })
const error = ref('')
async function load() {
  try {
    const q = new URLSearchParams()
    if (filter.status) q.set('status', filter.status)
    if (filter.overdue) q.set('overdue', 'true')
    items.value = await api<G[]>(`/development/goals/team?${q}`)
    statuses.value = await api<Status[]>('/development/goal-statuses')
  } catch (err) { error.value = apiErrorOf(err).message }
}
onMounted(load)
watch(filter, load)
const onReview = computed(() => items.value.filter(g => g.status_code === 'on_review').length)
</script>
<template>
  <div>
    <h1>{{ t('admin.nav.teamGoals') }}</h1>
    <p v-if="error" class="error">{{ error }}</p>
    <div class="row">
      <select v-model="filter.status" class="field"><option value="">{{ t('dev.allStatuses') }}</option><option v-for="s in statuses" :key="s.code" :value="s.code">{{ s.name }}</option></select>
      <label class="check"><input v-model="filter.overdue" type="checkbox"> {{ t('dev.onlyOverdue') }}</label>
      <span v-if="onReview" class="badge sun">{{ t('dev.onReviewN', { n: onReview }) }}</span>
    </div>
    <p v-if="items.length === 0" class="sub">{{ t('dev.noGoals') }}</p>
    <table v-else class="table">
      <thead><tr><th>{{ t('people.col.name') }}</th><th>{{ t('dev.goal') }}</th><th>{{ t('dev.due') }}</th><th>{{ t('assign.col.status') }}</th><th>%</th></tr></thead>
      <tbody>
        <tr v-for="g in items" :key="g.id" :class="{ overdue: g.is_overdue }">
          <td><b>{{ g.full_name }}</b><div class="sub">{{ g.location ?? '' }}</div></td>
          <td><NuxtLink :to="`/learn/development/goals/${g.id}`" class="link">{{ g.title }}</NuxtLink><div class="sub">{{ t(`dev.kind.${g.kind}`) }}</div></td>
          <td :class="{ red: g.is_overdue }">{{ g.due_at }}</td>
          <td><span :class="['badge', g.status_color]">{{ g.status_name }}</span></td>
          <td>{{ g.progress_pct }}</td>
        </tr>
      </tbody>
    </table>
  </div>
</template>
<style scoped>
h1 { margin: 0 0 var(--space-4); font-weight: 900; }
.table { width: 100%; border-collapse: collapse; background: var(--color-bg-soft); border-radius: var(--radius-m); overflow: hidden; }
th { text-align: left; font-size: var(--font-size-body-s); color: var(--color-ink-muted); padding: var(--space-2) var(--space-3); border-bottom: 1px solid var(--color-bg-line); }
td { padding: var(--space-2) var(--space-3); border-bottom: 1px solid var(--color-bg-line-soft); vertical-align: top; }
.row { display: flex; gap: var(--space-2); align-items: center; flex-wrap: wrap; margin-bottom: var(--space-3); }
.field { font: inherit; border: 1px solid var(--color-bg-line); border-radius: var(--radius-s); padding: var(--space-2) var(--space-3); background: var(--color-bg); color: var(--color-ink); }
.check { display: flex; gap: var(--space-1); align-items: center; font-size: var(--font-size-body-s); }
.link { color: var(--color-ink); font-weight: 700; }
.red { color: var(--color-coral-ink); font-weight: 700; }
.badge { font-size: var(--font-size-body-s); font-weight: 700; border-radius: var(--radius-pill); padding: 2px var(--space-3); background: var(--color-bg-line-soft); }
.badge.teal { background: var(--color-teal); color: var(--color-teal-deep); }
.badge.coral { background: var(--color-coral); color: var(--color-coral-deep); }
.badge.sun { background: var(--color-sun); color: var(--color-sun-ink); }
.sub { font-size: var(--font-size-body-s); color: var(--color-ink-faint); }
.error { color: var(--color-coral-ink); }
</style>
