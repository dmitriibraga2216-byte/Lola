<script setup lang="ts">
definePageMeta({ layout: 'admin', middleware: 'admin-scope', requiredScope: 'development.team' })
const { t } = useI18n()
const { api } = useApi()
const { hasScope } = useAuth()

interface PlanRow {
  id: string, user_id: string, full_name: string, position: string | null, location: string | null,
  summary: string | null, period_from: string, period_to: string, status: string,
  mentor_id: string | null, mentor_name: string | null, steps_total: number, steps_done: number, progressPct: number,
}
interface Counts { active: number, inactive: number, done: number }

const items = ref<PlanRow[]>([])
const counts = ref<Counts>({ active: 0, inactive: 0, done: 0 })
const tab = ref<'active' | 'inactive' | 'done'>('active')
const error = ref('')

async function load() {
  try {
    const r = await api<{ items: PlanRow[], counts: Counts }>('/development/plans', { query: { tab: tab.value } })
    items.value = r.items
    counts.value = r.counts
  }
  catch (err) { error.value = apiErrorOf(err).message }
}
onMounted(load)
watch(tab, load)

// Створення плану (докс/31 `DevelopmentPlans`) — людину обирає адмін/керівник з людей тенанту.
const people = ref<{ id: string, fullName: string }[]>([])
const creating = ref(false)
const form = reactive({ userId: '', periodFrom: '', periodTo: '', summary: '' })
async function openCreate() {
  if (!people.value.length) people.value = await api<{ id: string, fullName: string }[]>('/people', { query: { limit: 300 } }).catch(() => [])
  Object.assign(form, { userId: '', periodFrom: '', periodTo: '', summary: '' })
  creating.value = true
}
async function create() {
  error.value = ''
  try {
    await api('/development/plans', { method: 'POST', body: form })
    creating.value = false
    await load()
  }
  catch (err) { error.value = apiErrorOf(err).message }
}
</script>
<template>
  <div>
    <header class="head">
      <div>
        <div class="eyebrow">{{ t('dev.short') }}</div>
        <h1>{{ t('admin.nav.developmentPlans') }}</h1>
      </div>
      <button v-if="hasScope('development.team')" class="primary" @click="openCreate">{{ t('dev.newDevPlan') }}</button>
    </header>
    <p v-if="error" class="error" role="alert">{{ error }}</p>
    <div class="tabs">
      <button :class="['tab', { active: tab === 'active' }]" @click="tab = 'active'">{{ t('dev.planTab.active') }} · {{ counts.active }}</button>
      <button :class="['tab', { active: tab === 'inactive' }]" @click="tab = 'inactive'">{{ t('dev.planTab.inactive') }}</button>
      <button :class="['tab', { active: tab === 'done' }]" @click="tab = 'done'">{{ t('dev.planTab.done') }} · {{ counts.done }}</button>
    </div>
    <p v-if="items.length === 0" class="sub">{{ t('dev.noPlans') }}</p>
    <table v-else class="table">
      <thead>
        <tr>
          <th>{{ t('dev.plansCol.person') }}</th>
          <th>{{ t('dev.plansCol.goal') }}</th>
          <th>{{ t('dev.plansCol.period') }}</th>
          <th>{{ t('dev.plansCol.steps') }}</th>
          <th>{{ t('dev.plansCol.progress') }}</th>
          <th>{{ t('dev.plansCol.status') }}</th>
        </tr>
      </thead>
      <tbody>
        <tr v-for="p in items" :key="p.id" class="row-link" @click="navigateTo(`/admin/development/plans/${p.id}`)">
          <td><b>{{ p.full_name }}</b><div class="sub">{{ [p.position, p.location].filter(Boolean).join(' · ') }}</div></td>
          <td>{{ p.summary || '—' }}</td>
          <td>{{ p.period_from }} — {{ p.period_to }}</td>
          <td>{{ t('dev.stepsOf', { done: p.steps_done, total: p.steps_total }) }}</td>
          <td>
            <div class="bar"><div class="bar-fill" :style="{ width: `${p.progressPct}%` }" /></div>
          </td>
          <td><span :class="['badge', p.status === 'active' ? 'teal' : p.status === 'closed' ? 'muted' : 'sun']">{{ t(`dev.planAdminStatus.${p.status}`) }}</span></td>
        </tr>
      </tbody>
    </table>
    <div v-if="creating" class="overlay" @click.self="creating = false">
      <form class="modal" role="dialog" aria-modal="true" @submit.prevent="create">
        <h2>{{ t('dev.newDevPlan') }}</h2>
        <label>{{ t('dev.planPerson') }}
          <select v-model="form.userId" required class="field">
            <option value="" disabled>—</option>
            <option v-for="u in people" :key="u.id" :value="u.id">{{ u.fullName }}</option>
          </select>
        </label>
        <div class="two">
          <label>{{ t('peopleReport.from') }}<input v-model="form.periodFrom" type="date" required class="field"></label>
          <label>{{ t('peopleReport.to') }}<input v-model="form.periodTo" type="date" required class="field"></label>
        </div>
        <label>{{ t('dev.planGoal') }}<input v-model="form.summary" class="field" maxlength="2000"></label>
        <div class="actions"><button type="button" class="chip" @click="creating = false">{{ t('common.cancel') }}</button><button type="submit" class="primary" :disabled="!form.userId || !form.periodFrom || !form.periodTo">{{ t('common.save') }}</button></div>
      </form>
    </div>
  </div>
</template>
<style scoped>
.head { display: flex; align-items: flex-end; justify-content: space-between; gap: var(--space-3); margin-bottom: var(--space-3); flex-wrap: wrap; }
.eyebrow { font-size: var(--font-size-body-s); font-weight: 700; color: var(--color-ink-muted); }
h1 { margin: 0; font-weight: 900; }
h2 { margin: 0; font-weight: 800; }
.tabs { display: flex; gap: var(--space-2); margin-bottom: var(--space-3); flex-wrap: wrap; }
.tab { font: inherit; font-size: var(--font-size-body-s); font-weight: 700; border: none; background: var(--color-bg-soft); color: var(--color-ink-muted); border-radius: var(--radius-pill); padding: var(--space-2) var(--space-4); cursor: pointer; }
.tab.active { background: var(--color-ink); color: var(--color-bg-soft); font-weight: 800; }
.table { width: 100%; border-collapse: collapse; background: var(--color-bg-soft); border-radius: var(--radius-m); overflow: hidden; }
th { text-align: left; font-size: var(--font-size-body-s); color: var(--color-ink-muted); padding: var(--space-2) var(--space-3); border-bottom: 1px solid var(--color-bg-line); }
td { padding: var(--space-3); border-bottom: 1px solid var(--color-bg-line-soft); vertical-align: middle; }
.row-link { cursor: pointer; }
.row-link:hover { background: var(--color-bg-line-soft); }
.bar { height: 8px; background: var(--color-bg-line-soft); border-radius: var(--radius-pill); overflow: hidden; width: 120px; }
.bar-fill { height: 100%; background: var(--color-teal); border-radius: var(--radius-pill); }
.badge { font-size: var(--font-size-body-s); font-weight: 700; border-radius: var(--radius-pill); padding: 2px var(--space-3); background: var(--color-bg-line-soft); white-space: nowrap; }
.badge.teal { background: var(--color-teal); color: var(--color-teal-deep); }
.badge.sun { background: var(--color-sun); color: var(--color-sun-ink); }
.badge.muted { background: var(--color-bg-line-soft); color: var(--color-ink-muted); }
.sub { font-size: var(--font-size-body-s); color: var(--color-ink-faint); }
.error { color: var(--color-coral-ink); }
.primary { font: inherit; font-weight: 800; border: none; background: var(--color-sun); color: var(--color-ink); border-radius: var(--radius-pill); padding: var(--space-2) var(--space-4); cursor: pointer; }
.primary:disabled { opacity: 0.5; }
.chip { font: inherit; font-size: var(--font-size-body-s); font-weight: 700; border: 1px solid var(--color-bg-line); background: transparent; color: var(--color-ink-muted); border-radius: var(--radius-pill); padding: var(--space-1) var(--space-3); cursor: pointer; }
.overlay { position: fixed; inset: 0; background: rgb(0 0 0 / 40%); display: grid; place-items: center; padding: var(--space-3); z-index: 20; overflow: auto; }
.modal { background: var(--color-bg-soft); border-radius: var(--radius-l); padding: var(--space-4); display: grid; gap: var(--space-2); width: min(480px, 100%); box-sizing: border-box; max-height: 100%; overflow: auto; }
.modal label { display: grid; gap: var(--space-1); font-size: var(--font-size-body-s); color: var(--color-ink-muted); }
.field { font: inherit; border: 1px solid var(--color-bg-line); border-radius: var(--radius-s); padding: var(--space-1) var(--space-2); background: var(--color-bg); color: var(--color-ink); min-width: 0; box-sizing: border-box; }
.two { display: grid; grid-template-columns: 1fr 1fr; gap: var(--space-2); }
.actions { display: flex; gap: var(--space-2); justify-content: flex-end; }
</style>
