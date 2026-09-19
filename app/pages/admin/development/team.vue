<script setup lang="ts">
definePageMeta({ layout: 'admin', middleware: 'admin-scope', requiredScope: 'development.team' })
const { t } = useI18n()
const { api } = useApi()
interface G { id: string, title: string, kind: string, due_at: string, status_code: string, status_name: string, status_color: string, is_final: boolean, progress_pct: number, user_id: string, full_name: string, location: string | null, is_overdue: boolean, approved_at: string | null, return_comment: string | null }
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
const toApprove = computed(() => items.value.filter(g => !g.approved_at && !g.return_comment).length)
const returning = ref<string | null>(null)
const returnComment = ref('')
async function decide(g: G, decision: 'approve' | 'return') {
  error.value = ''
  try { await api(`/development/goals/${g.id}/approve`, { method: 'POST', body: { decision, comment: decision === 'return' ? returnComment.value : undefined } }); returning.value = null; returnComment.value = ''; await load() }
  catch (err) { error.value = apiErrorOf(err).message }
}
async function remindAll() {
  const overdue = items.value.filter(g => g.is_overdue)
  for (const g of overdue) await api(`/development/goals/${g.id}/comments`, { method: 'POST', body: { body: t('dev.remindText') } }).catch(() => null)
}
</script>
<template>
  <div>
    <h1>{{ t('admin.nav.teamGoals') }}</h1>
    <p v-if="error" class="error">{{ error }}</p>
    <div class="row">
      <select v-model="filter.status" class="field"><option value="">{{ t('dev.allStatuses') }}</option><option v-for="s in statuses" :key="s.code" :value="s.code">{{ s.name }}</option></select>
      <label class="check"><input v-model="filter.overdue" type="checkbox"> {{ t('dev.onlyOverdue') }}</label>
      <span v-if="onReview" class="badge sun">{{ t('dev.onReviewN', { n: onReview }) }}</span>
      <span v-if="toApprove" class="badge coral">{{ t('dev.toApproveN', { n: toApprove }) }}</span>
      <button v-if="items.some(g => g.is_overdue)" class="chip" @click="remindAll">{{ t('dev.remindAll') }}</button>
      <NuxtLink to="/admin/development/matrix" class="chip">{{ t('dev.matrix') }}</NuxtLink>
    </div>
    <p v-if="items.length === 0" class="sub">{{ t('dev.noGoals') }}</p>
    <table v-else class="table">
      <thead><tr><th>{{ t('people.col.name') }}</th><th>{{ t('dev.goal') }}</th><th>{{ t('dev.due') }}</th><th>{{ t('assign.col.status') }}</th><th>%</th></tr></thead>
      <tbody>
        <tr v-for="g in items" :key="g.id" :class="{ overdue: g.is_overdue }">
          <td><b>{{ g.full_name }}</b><div class="sub">{{ g.location ?? '' }}</div></td>
          <td><NuxtLink :to="`/learn/development/goals/${g.id}`" class="link">{{ g.title }}</NuxtLink><div class="sub">{{ t(`dev.kind.${g.kind}`) }}</div></td>
          <td :class="{ red: g.is_overdue }">{{ g.due_at }}</td>
          <td>
            <span :class="['badge', g.status_color]">{{ g.status_name }}</span>
            <div v-if="!g.approved_at" class="approve">
              <span v-if="g.return_comment" class="sub">{{ t('dev.returned') }}: {{ g.return_comment }}</span>
              <template v-else>
                <button class="chip" @click="decide(g, 'approve')">{{ t('dev.approve') }}</button>
                <button class="chip" @click="returning = returning === g.id ? null : g.id">{{ t('dev.return') }}</button>
                <div v-if="returning === g.id" class="row"><input v-model="returnComment" class="field" :placeholder="t('dev.returnComment')"><button class="chip" :disabled="returnComment.length < 3" @click="decide(g, 'return')">OK</button></div>
              </template>
            </div>
          </td>
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
.chip { font: inherit; font-size: var(--font-size-body-s); font-weight: 700; border: 1px solid var(--color-bg-line); background: transparent; color: var(--color-ink-muted); border-radius: var(--radius-pill); padding: var(--space-1) var(--space-3); cursor: pointer; text-decoration: none; }
.approve { display: flex; gap: var(--space-1); flex-wrap: wrap; margin-top: var(--space-1); }
</style>
