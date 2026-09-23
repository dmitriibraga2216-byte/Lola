<script setup lang="ts">
/**
 * Звіт по воронці — `/admin/reports/recruiting-funnel` (docs/v2/28 §9 п. 1, docs/22 §13.3).
 *
 * Два шари: агрегат по колонках («де втрачаємо») і список людей єдиним каркасом колонок
 * («хто саме»). Каркас — той самий, що в усіх звітах репозиторію: ПІБ · посада · місто ·
 * підрозділ · мітки; відмінність одна — вид людини `candidate`.
 */
definePageMeta({ layout: 'admin', middleware: 'admin-scope', requiredScope: 'candidate.view' })

const { t } = useI18n()
const { api } = useApi()

interface Stage { statusId: string, code: string, nameUk: string, mapsTo: string, entered: number, current: number, sharePct: number, avgDays: number | null, toNextPct: number | null }
interface Summary { entered: number, hired: number, rejected: number, archived: number, withdrawn: number, active: number, medianDaysToHire: number | null }
interface Row { user_id: string, full_name: string, position: string | null, city: string | null, unit: string | null, tags: string[], state: string | null, funnel_status: string | null, recruiter: string | null, added_at: string | null, hired_at: string | null }

const from = ref('')
const to = ref('')
const stages = ref<Stage[]>([])
const summary = ref<Summary | null>(null)
const rows = ref<Row[]>([])
const error = ref('')
const busy = ref(false)

async function load() {
  busy.value = true
  error.value = ''
  try {
    const res = await api<{ stages: Stage[], summary: Summary, rows: Row[] }>('/reports/recruiting-funnel', {
      query: { ...(from.value ? { from: from.value } : {}), ...(to.value ? { to: to.value } : {}) },
    })
    stages.value = res.stages
    summary.value = res.summary
    rows.value = res.rows
  }
  catch (err) { error.value = apiErrorOf(err).message }
  finally { busy.value = false }
}
onMounted(load)

const dateOf = (v: string | null) => v ? new Date(v).toLocaleDateString('uk', { day: '2-digit', month: '2-digit', year: 'numeric' }) : '—'
</script>

<template>
  <div>
    <PageHeader :title="t('funnelReport.title')" :subtitle="t('funnelReport.hint')" />

    <p v-if="error" class="error" role="alert">{{ error }}</p>

    <div class="filters">
      <label>{{ t('funnelReport.from') }} <input v-model="from" type="date"></label>
      <label>{{ t('funnelReport.to') }} <input v-model="to" type="date"></label>
      <button class="btn" type="button" :disabled="busy" @click="load">{{ t('funnelReport.apply') }}</button>
    </div>

    <section v-if="summary" class="panel tiles">
      <div class="tile"><span class="sub">{{ t('funnelReport.entered') }}</span><strong>{{ summary.entered }}</strong></div>
      <div class="tile"><span class="sub">{{ t('funnelReport.active') }}</span><strong>{{ summary.active }}</strong></div>
      <div class="tile"><span class="sub">{{ t('funnelReport.hired') }}</span><strong>{{ summary.hired }}</strong></div>
      <div class="tile"><span class="sub">{{ t('funnelReport.rejected') }}</span><strong>{{ summary.rejected }}</strong></div>
      <div class="tile"><span class="sub">{{ t('funnelReport.medianDays') }}</span><strong>{{ summary.medianDaysToHire ?? '—' }}</strong></div>
    </section>

    <section class="panel">
      <table class="table">
        <thead>
          <tr>
            <th>{{ t('funnelReport.stage') }}</th>
            <th>{{ t('funnelReport.enteredCol') }}</th>
            <th>{{ t('funnelReport.currentCol') }}</th>
            <th>{{ t('funnelReport.shareCol') }}</th>
            <th>{{ t('funnelReport.avgDaysCol') }}</th>
            <th>{{ t('funnelReport.toNextCol') }}</th>
          </tr>
        </thead>
        <tbody>
          <tr v-for="s in stages" :key="s.statusId">
            <td>{{ s.nameUk }}</td>
            <td>{{ s.entered }}</td>
            <td>{{ s.current }}</td>
            <td>{{ s.sharePct }}%</td>
            <td>{{ s.avgDays ?? '—' }}</td>
            <td>{{ s.toNextPct === null ? '—' : `${s.toNextPct}%` }}</td>
          </tr>
          <tr v-if="!stages.length"><td colspan="6" class="sub">{{ t('funnelReport.empty') }}</td></tr>
        </tbody>
      </table>
    </section>

    <section class="panel">
      <h2 class="title">{{ t('funnelReport.people') }}</h2>
      <table class="table">
        <thead>
          <tr>
            <th>{{ t('frame.col.full_name') }}</th>
            <th>{{ t('frame.col.city') }}</th>
            <th>{{ t('funnelReport.statusCol') }}</th>
            <th>{{ t('funnelReport.stateCol') }}</th>
            <th>{{ t('funnelReport.recruiterCol') }}</th>
            <th>{{ t('funnelReport.addedCol') }}</th>
            <th>{{ t('funnelReport.hiredCol') }}</th>
          </tr>
        </thead>
        <tbody>
          <tr v-for="r in rows" :key="r.user_id">
            <td><NuxtLink class="link" :to="`/admin/candidates/${r.user_id}`">{{ r.full_name }}</NuxtLink></td>
            <td>{{ r.city ?? '—' }}</td>
            <td>{{ r.funnel_status ?? '—' }}</td>
            <td>{{ r.state ? t(`candidate.state.${r.state}`) : t('funnelReport.hired') }}</td>
            <td>{{ r.recruiter ?? '—' }}</td>
            <td>{{ dateOf(r.added_at) }}</td>
            <td>{{ dateOf(r.hired_at) }}</td>
          </tr>
          <tr v-if="!rows.length"><td colspan="7" class="sub">{{ t('funnelReport.empty') }}</td></tr>
        </tbody>
      </table>
    </section>
  </div>
</template>

<style scoped>
.filters { display: flex; flex-wrap: wrap; gap: var(--space-2); align-items: end; margin-bottom: var(--space-3); }
.title { font-size: var(--text-h3, inherit); margin: 0 0 var(--space-2); }
.tiles { display: flex; flex-wrap: wrap; gap: var(--space-4); }
.tile { display: grid; gap: var(--space-1); }
.table { width: 100%; border-collapse: collapse; }
.table th, .table td { text-align: left; padding: var(--space-1) var(--space-2); border-bottom: 1px solid var(--color-bg-line); }
@media (max-width: 480px) {
  .filters { flex-direction: column; align-items: stretch; }
  .table { display: block; overflow-x: auto; }
}
</style>
