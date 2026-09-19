<script setup lang="ts">
definePageMeta({ layout: 'admin', middleware: 'admin-scope', requiredScope: 'report.team' })
const { t } = useI18n()
const { api } = useApi()
interface Run { id: string, started_at: string, score: string, passed: boolean, critical_failed: string[], action_plan: { status: string }[], title: string, kind: string, location: string | null, observer: string }
interface Rep { runs: Run[], byLocationWeek: { location: string, week: string, avg_score: string, runs: number }[], topFailed: { checklist: string, text: string, total: number, failed: number }[], actions: { total: number, done: number, overdue: number }, discipline: { checklist: string, location: string, norm: number, done: number }[] }
const rep = ref<Rep | null>(null)
interface MRep { waves: { id: string, title: string, startsAt: string, status: string }[], locations: { id: string, name: string }[], cells: Record<string, { avg: number, runs: number, passed: number }> }
const mystery = ref<MRep | null>(null)
const tab = ref<'runs' | 'mystery'>('runs')
async function loadMystery() { try { mystery.value = await api('/mystery/report') } catch { mystery.value = null } }
const color = (avg: number) => avg >= 90 ? 'teal' : avg >= 70 ? 'sun' : 'coral'
const error = ref('')
const filter = reactive({ from: '', to: '' })
async function load() {
  const q = new URLSearchParams(); if (filter.from) q.set('from', filter.from); if (filter.to) q.set('to', filter.to)
  try { rep.value = await api(`/reports/checklists?${q}`) } catch (err) { error.value = apiErrorOf(err).message }
}
onMounted(() => { load(); loadMystery() })
const fmt = (d: string) => new Date(d).toLocaleString('uk-UA', { dateStyle: 'short', timeStyle: 'short' })
</script>
<template>
  <div>
    <h1>{{ t('admin.nav.checklistReport') }}</h1>
    <p v-if="error" class="error">{{ error }}</p>
    <div class="tabs" role="tablist"><button role="tab" :aria-selected="tab === 'runs'" :class="['tab', { on: tab === 'runs' }]" @click="tab = 'runs'">{{ t('cl.runs') }}</button><button role="tab" :aria-selected="tab === 'mystery'" :class="['tab', { on: tab === 'mystery' }]" @click="tab = 'mystery'">{{ t('mystery.title') }}</button></div>
    <section v-if="tab === 'mystery'" class="card">
      <h2>{{ t('mystery.reportTitle') }}</h2>
      <p v-if="!mystery || mystery.waves.length === 0" class="sub">{{ t('person.noData') }}</p>
      <div v-else class="table-wrap">
        <table class="table plain">
          <thead><tr><th>{{ t('people.col.location') }}</th><th v-for="w in mystery.waves" :key="w.id">{{ w.title }}<div class="sub">{{ w.startsAt }} · {{ t(`mystery.status.${w.status}`) }}</div></th></tr></thead>
          <tbody>
            <tr v-for="l in mystery.locations" :key="l.id">
              <td><b>{{ l.name }}</b></td>
              <td v-for="w in mystery.waves" :key="w.id"><span v-if="mystery.cells[`${w.id}:${l.id}`]" :class="['cell', color(mystery.cells[`${w.id}:${l.id}`]!.avg)]">{{ mystery.cells[`${w.id}:${l.id}`]!.avg }}%<small> · {{ mystery.cells[`${w.id}:${l.id}`]!.runs }}</small></span><span v-else class="sub">—</span></td>
            </tr>
          </tbody>
        </table>
      </div>
    </section>
    <div v-if="tab === 'runs'" class="row"><input v-model="filter.from" class="field" type="date" @change="load"><input v-model="filter.to" class="field" type="date" @change="load"></div>
    <template v-if="rep && tab === 'runs'">
      <div class="kpis">
        <div class="kpi"><b>{{ rep.runs.length }}</b><span>{{ t('cl.runs') }}</span></div>
        <div class="kpi"><b>{{ rep.runs.length ? Math.round(rep.runs.filter(r => r.passed).length / rep.runs.length * 100) : 0 }}%</b><span>{{ t('cl.passedShare') }}</span></div>
        <div class="kpi"><b>{{ rep.actions.done }} / {{ rep.actions.total }}</b><span>{{ t('cl.actionsDone') }}<template v-if="rep.actions.overdue"> · {{ rep.actions.overdue }} {{ t('dev.overdue') }}</template></span></div>
      </div>
      <section class="card">
        <h2>{{ t('cl.discipline') }}</h2>
        <table class="table plain"><thead><tr><th>{{ t('cl.checklist') }}</th><th>{{ t('people.col.location') }}</th><th>{{ t('cl.thisWeek') }}</th></tr></thead>
          <tbody><tr v-for="(d, i) in rep.discipline" :key="i" :class="{ red: d.done < d.norm }"><td>{{ d.checklist }}</td><td>{{ d.location }}</td><td>{{ d.done }} / {{ d.norm }}</td></tr></tbody></table>
      </section>
      <section class="card">
        <h2>{{ t('cl.topFailed') }}</h2>
        <table class="table plain"><tbody><tr v-for="(f, i) in rep.topFailed" :key="i"><td>{{ f.checklist }}</td><td>{{ f.text }}</td><td>{{ f.failed }} / {{ f.total }}</td></tr></tbody></table>
      </section>
      <section class="card">
        <h2>{{ t('cl.byWeek') }}</h2>
        <table class="table plain"><thead><tr><th>{{ t('cl.week') }}</th><th>{{ t('people.col.location') }}</th><th>%</th><th>{{ t('cl.runs') }}</th></tr></thead>
          <tbody><tr v-for="(w, i) in rep.byLocationWeek" :key="i"><td>{{ w.week }}</td><td>{{ w.location }}</td><td>{{ w.avg_score }}</td><td>{{ w.runs }}</td></tr></tbody></table>
      </section>
      <table class="table">
        <thead><tr><th>{{ t('cl.date') }}</th><th>{{ t('people.col.location') }}</th><th>{{ t('cl.observer') }}</th><th>{{ t('cl.checklist') }}</th><th>%</th><th>{{ t('cl.critical') }}</th><th>{{ t('cl.actionPlan') }}</th></tr></thead>
        <tbody>
          <tr v-for="r in rep.runs" :key="r.id">
            <td><NuxtLink :to="`/learn/checklists/${r.id}`" class="link">{{ fmt(r.started_at) }}</NuxtLink></td><td>{{ r.location ?? '—' }}</td><td>{{ r.observer }}</td><td>{{ r.title }}<div class="sub">{{ t(`cl.kind.${r.kind}`) }}</div></td>
            <td :class="r.passed ? 'ok' : 'red'">{{ Number(r.score) }}</td><td>{{ r.critical_failed.length || '' }}</td><td>{{ r.action_plan.filter(a => a.status === 'done').length }} / {{ r.action_plan.length }}</td>
          </tr>
        </tbody>
      </table>
    </template>
  </div>
</template>
<style scoped>
h1 { margin: 0 0 var(--space-3); font-weight: 900; }
h2 { margin: 0; font-weight: 800; }
.row { display: flex; gap: var(--space-2); flex-wrap: wrap; margin-bottom: var(--space-3); }
.field { font: inherit; border: 1px solid var(--color-bg-line); border-radius: var(--radius-s); padding: var(--space-2) var(--space-3); background: var(--color-bg); color: var(--color-ink); }
.kpis { display: flex; gap: var(--space-2); flex-wrap: wrap; margin-bottom: var(--space-3); }
.kpi { background: var(--color-bg-soft); border-radius: var(--radius-l); padding: var(--space-3) var(--space-4); display: grid; }
.kpi b { font-size: var(--font-size-title-l); font-weight: 900; }
.kpi span { color: var(--color-ink-muted); font-size: var(--font-size-body-s); }
.card { background: var(--color-bg-soft); border-radius: var(--radius-l); padding: var(--space-4); display: grid; gap: var(--space-2); margin-bottom: var(--space-3); }
.table { width: 100%; border-collapse: collapse; background: var(--color-bg-soft); border-radius: var(--radius-m); overflow: hidden; }
.table.plain { background: transparent; }
th { text-align: left; font-size: var(--font-size-body-s); color: var(--color-ink-muted); padding: var(--space-2) var(--space-3); border-bottom: 1px solid var(--color-bg-line); }
td { padding: var(--space-2) var(--space-3); border-bottom: 1px solid var(--color-bg-line-soft); vertical-align: top; }
.link { color: var(--color-ink); font-weight: 700; }
.ok { color: var(--color-teal-deep); font-weight: 700; }
.red { color: var(--color-coral-deep); font-weight: 700; }
.sub { font-size: var(--font-size-body-s); color: var(--color-ink-faint); }
.error { color: var(--color-coral-ink); }
.tabs { display: flex; gap: var(--space-2); margin-bottom: var(--space-3); }
.tab { font: inherit; font-weight: 700; border: 1px solid var(--color-bg-line); background: transparent; color: var(--color-ink-muted); border-radius: var(--radius-pill); padding: var(--space-1) var(--space-4); cursor: pointer; }
.tab.on { background: var(--color-ink); border-color: var(--color-ink); color: var(--color-bg-soft); }
.table-wrap { overflow-x: auto; }
.cell { font-weight: 800; border-radius: var(--radius-s); padding: 2px var(--space-2); }
.cell.teal { background: var(--color-teal); color: var(--color-teal-deep); }
.cell.sun { background: var(--color-sun); color: var(--color-sun-ink); }
.cell.coral { background: var(--color-coral); color: var(--color-coral-deep); }
</style>
