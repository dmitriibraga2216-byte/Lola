<script setup lang="ts">
const { formatShortDate } = useFormat()
definePageMeta({ layout: 'admin', middleware: 'admin-scope', requiredScope: 'assessment.run' })
const { t } = useI18n()
const { api } = useApi()
const route = useRoute()
interface Task { id: string, status: string, rater_kind: string, subject_id: string, subject_name: string, rater_id: string, rater_name: string, submitted_at: string | null }
interface Data { cycle: { id: string, title: string, status: string, calibration: boolean, endsAt: string, minRatersToShow: number }, tasks: Task[] }
const data = ref<Data | null>(null)
const error = ref('')
const notice = ref('')
const report = ref<Record<string, unknown>[]>([])
const byGroupText = (v: unknown) => v ? Object.entries(v as Record<string, number>).map(([g, n]) => `${g}: ${n}`).join(' · ') : '—'
const gapsOf = (v: unknown) => (v as { criterion: string, gap: number }[] | null) ?? []
async function load() {
  try { data.value = await api<Data>(`/assessment/cycles/${route.params.id}`); report.value = await api(`/reports/assessment?cycleId=${route.params.id}`) } catch (err) { error.value = apiErrorOf(err).message }
}
onMounted(load)
async function act(action: string) {
  error.value = ''; notice.value = ''
  try { const r = await api<Record<string, unknown>>(`/assessment/cycles/${route.params.id}/${action}`, { method: 'POST' }); notice.value = action === 'remind' ? t('assess.reminded', { n: r.reminded }) : t('common.saved'); await load() }
  catch (err) { error.value = apiErrorOf(err).message }
}
const subjects = computed(() => { const m = new Map<string, Task[]>(); for (const tk of data.value?.tasks ?? []) m.set(tk.subject_id, [...(m.get(tk.subject_id) ?? []), tk]); return [...m] })
const notSubmitted = computed(() => data.value?.tasks.filter(tk => ['pending', 'in_progress'].includes(tk.status)) ?? [])
</script>
<template>
  <div>
    <NuxtLink to="/admin/assessment/cycles" class="back">← {{ t('admin.nav.assessCycles') }}</NuxtLink>
    <p v-if="error" class="error">{{ error }}</p>
    <p v-if="notice" class="notice">{{ notice }}</p>
    <template v-if="data">
      <div class="head">
        <h1>{{ data.cycle.title }}</h1>
        <span :class="['badge', data.cycle.status]">{{ t(`assess.cycleStatus.${data.cycle.status}`) }}</span>
      </div>
      <p class="sub">{{ t('assess.monitor', { total: data.tasks.length, submitted: data.tasks.filter(tk => tk.status === 'submitted').length, pending: notSubmitted.length }) }}</p>
      <div class="row">
        <button v-if="data.cycle.status === 'active'" class="chip" @click="act('remind')">{{ t('assess.remind') }}</button>
        <button v-if="data.cycle.status === 'active' && data.cycle.calibration" class="chip" @click="act('calibrate')">{{ t('assess.toCalibration') }}</button>
        <button v-if="['active', 'calibration'].includes(data.cycle.status)" class="primary" data-testid="cycle-finish" @click="act('finish')">{{ t('assess.finish') }}</button>
        <button v-if="['draft', 'active', 'calibration'].includes(data.cycle.status)" class="chip" @click="act('cancel')">{{ t('common.cancel') }}</button>
      </div>
      <section v-if="notSubmitted.length && data.cycle.status === 'active'" class="card">
        <h2>{{ t('assess.notFilled') }}</h2>
        <p class="sub">{{ [...new Set(notSubmitted.map(tk => tk.rater_name))].join(', ') }}</p>
      </section>
      <table class="table">
        <thead><tr><th>{{ t('assess.subject') }}</th><th>{{ t('assess.raters') }}</th><th /></tr></thead>
        <tbody>
          <tr v-for="[sid, tasks] in subjects" :key="sid">
            <td><b>{{ tasks[0]!.subject_name }}</b></td>
            <td class="sub"><span v-for="tk in tasks" :key="tk.id" :class="['pill', tk.status]">{{ t(`assess.kind.${tk.rater_kind}`) }}: {{ tk.rater_name }}</span></td>
            <td><NuxtLink :to="`/learn/assessment/results/${data.cycle.id}?userId=${sid}`" class="link">{{ t('assess.results') }}</NuxtLink></td>
          </tr>
        </tbody>
      </table>
      <section v-if="report.length" class="card">
        <h2>{{ t('assess.reportTitle') }}</h2>
        <table class="table plain">
          <thead><tr><th>{{ t('assess.report.subject') }}</th><th>{{ t('assess.report.raterKind') }}</th><th>{{ t('assess.report.filled') }}</th><th>{{ t('assess.report.filledAt') }}</th><th>{{ t('assess.report.avg') }}</th><th>{{ t('assess.report.byGroup') }}</th><th>{{ t('assess.report.normGap') }}</th></tr></thead>
          <tbody>
            <tr v-for="r in report" :key="String(r.task_id)">
              <td>{{ r.full_name }}</td><td>{{ t(`assess.kind.${r.rater_kind}`) }}</td><td>{{ r.filled ? t('common.yes') : t('common.no') }}</td>
              <td>{{ r.completed_at ? formatShortDate(new Date(String(r.completed_at))) : '—' }}</td><td>{{ r.avg_score ?? '—' }}</td>
              <td class="sub">{{ byGroupText(r.by_group) }}</td>
              <td class="gaps"><span v-for="g in gapsOf(r.gaps)" :key="g.criterion" :class="['gap', { red: g.gap < 0 }]" :title="g.criterion">{{ g.gap > 0 ? '+' : '' }}{{ g.gap }}</span><span v-if="!gapsOf(r.gaps).length">—</span></td>
            </tr>
          </tbody>
        </table>
      </section>
    </template>
  </div>
</template>
<style scoped>
.back { color: var(--color-ink-muted); text-decoration: none; font-weight: 700; }
.head { display: flex; justify-content: space-between; align-items: center; gap: var(--space-2); margin: var(--space-2) 0; }
h1 { margin: 0; font-weight: 900; }
h2 { margin: 0; font-weight: 800; }
.row { display: flex; gap: var(--space-2); flex-wrap: wrap; margin: var(--space-2) 0 var(--space-3); }
.card { background: var(--color-bg-soft); border-radius: var(--radius-l); padding: var(--space-4); display: grid; gap: var(--space-2); margin-bottom: var(--space-3); }
.table { width: 100%; border-collapse: collapse; background: var(--color-bg-soft); border-radius: var(--radius-m); overflow: hidden; margin-bottom: var(--space-3); }
.table.plain { background: transparent; }
th { text-align: left; font-size: var(--font-size-body-s); color: var(--color-ink-muted); padding: var(--space-2) var(--space-3); border-bottom: 1px solid var(--color-bg-line); }
td { padding: var(--space-2) var(--space-3); border-bottom: 1px solid var(--color-bg-line-soft); vertical-align: top; }
.pill { display: inline-block; margin: 2px 4px 2px 0; padding: 1px var(--space-2); border-radius: var(--radius-pill); background: var(--color-bg); }
.pill.submitted { background: var(--color-teal); color: var(--color-teal-deep); }
.pill.declined, .pill.expired { opacity: 0.5; text-decoration: line-through; }
.link { color: var(--color-ink); font-weight: 700; }
.red { color: var(--color-coral-deep); font-weight: 700; }
.badge { font-size: var(--font-size-body-s); font-weight: 700; border-radius: var(--radius-pill); padding: 2px var(--space-3); background: var(--color-bg-line-soft); }
.badge.active { background: var(--color-teal); color: var(--color-teal-deep); }
.chip { font: inherit; font-size: var(--font-size-body-s); font-weight: 700; border: 1px solid var(--color-bg-line); background: transparent; color: var(--color-ink-muted); border-radius: var(--radius-pill); padding: var(--space-1) var(--space-3); cursor: pointer; }
.primary { font: inherit; font-weight: 800; border: none; background: var(--color-sun); color: var(--color-ink); border-radius: var(--radius-pill); padding: var(--space-2) var(--space-4); cursor: pointer; }
.sub { font-size: var(--font-size-body-s); color: var(--color-ink-faint); margin: 0; }
.error { color: var(--color-coral-ink); }
.notice { color: var(--color-teal-ink); }
.gaps { display: flex; flex-wrap: wrap; gap: 4px; }
.gap { font-size: var(--font-size-body-s); font-weight: 700; padding: 0 6px; border-radius: var(--radius-pill); background: var(--color-bg-line-soft); }
.gap.red { background: var(--color-coral-soft); color: var(--color-coral-ink); }
</style>
