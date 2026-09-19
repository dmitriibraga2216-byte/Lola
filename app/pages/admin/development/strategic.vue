<script setup lang="ts">
definePageMeta({ layout: 'admin', middleware: 'admin-scope', requiredScope: 'development.team' })
const { t } = useI18n()
const { api } = useApi()
const { hasScope } = useAuth()
interface Plan { id: string, title: string, period_from: string, period_to: string, org_unit_id: string | null, org_unit_name: string | null, goals: { title: string, metric?: string, target?: string }[], budget: string | null, kpi: { name: string, target?: string, unit?: string }[], status: string, owner_name: string | null }
const items = ref<Plan[]>([])
const units = ref<{ id: string, name: string }[]>([])
const error = ref('')
const editing = ref(false)
const blank = () => ({ id: '', title: '', periodFrom: '', periodTo: '', orgUnitId: '', goals: [] as { title: string, metric: string, target: string }[], budget: '' as string | number, kpi: [] as { name: string, target: string, unit: string }[], status: 'draft' as 'draft' | 'active' | 'closed' })
const form = reactive(blank())
async function load() { try { items.value = await api('/strategic-plans'); units.value = await api('/refs/org-units') } catch (err) { error.value = apiErrorOf(err).message } }
onMounted(load)
function openNew() { Object.assign(form, blank()); editing.value = true }
function openEdit(p: Plan) {
  Object.assign(form, { id: p.id, title: p.title, periodFrom: p.period_from, periodTo: p.period_to, orgUnitId: p.org_unit_id ?? '', goals: p.goals.map(g => ({ title: g.title, metric: g.metric ?? '', target: g.target ?? '' })), budget: p.budget ?? '', kpi: p.kpi.map(k => ({ name: k.name, target: k.target ?? '', unit: k.unit ?? '' })), status: p.status })
  editing.value = true
}
async function save() {
  error.value = ''
  try {
    await api('/strategic-plans', { method: 'PUT', body: { ...(form.id ? { id: form.id } : {}), title: form.title, periodFrom: form.periodFrom, periodTo: form.periodTo, orgUnitId: form.orgUnitId || null, goals: form.goals.filter(g => g.title.trim()), budget: form.budget === '' ? null : Number(form.budget), kpi: form.kpi.filter(k => k.name.trim()), status: form.status } })
    editing.value = false; await load()
  } catch (err) { error.value = apiErrorOf(err).message }
}
async function remove(p: Plan) { if (!confirm(t('dev.deletePlanConfirm', { title: p.title }))) return; try { await api(`/strategic-plans/${p.id}`, { method: 'DELETE' }); await load() } catch (err) { error.value = apiErrorOf(err).message } }
</script>
<template>
  <div>
    <header class="head"><h1>{{ t('dev.strategic') }}</h1><button v-if="hasScope('development.manage')" class="primary" @click="openNew">{{ t('dev.newPlan') }}</button></header>
    <p v-if="error" class="error" role="alert">{{ error }}</p>
    <p v-if="items.length === 0" class="sub">{{ t('person.noData') }}</p>
    <ul class="list">
      <li v-for="p in items" :key="p.id" class="card">
        <div class="row"><b>{{ p.title }}</b><span :class="['badge', p.status]">{{ t(`dev.planStatus.${p.status}`) }}</span><span class="sub">{{ p.period_from }} — {{ p.period_to }}{{ p.org_unit_name ? ` · ${p.org_unit_name}` : '' }}{{ p.budget ? ` · ${p.budget} ₴` : '' }}</span></div>
        <ul v-if="p.goals.length" class="inner"><li v-for="(g, i) in p.goals" :key="i">• {{ g.title }}<span v-if="g.metric" class="sub"> — {{ g.metric }}{{ g.target ? `: ${g.target}` : '' }}</span></li></ul>
        <ul v-if="p.kpi.length" class="inner"><li v-for="(k, i) in p.kpi" :key="i" class="sub">KPI: {{ k.name }}{{ k.target ? ` ≥ ${k.target}${k.unit ?? ''}` : '' }}</li></ul>
        <div v-if="hasScope('development.manage')" class="row"><button class="chip" @click="openEdit(p)">{{ t('common.edit') }}</button><button class="chip danger" @click="remove(p)">{{ t('groups.delete') }}</button></div>
      </li>
    </ul>
    <div v-if="editing" class="overlay" @click.self="editing = false">
      <form class="modal" role="dialog" aria-modal="true" @submit.prevent="save">
        <h2>{{ form.id ? t('common.edit') : t('dev.newPlan') }}</h2>
        <label>{{ t('dev.planTitle') }}<input v-model="form.title" required minlength="3" maxlength="200"></label>
        <div class="two"><label>{{ t('peopleReport.from') }}<input v-model="form.periodFrom" type="date" required></label><label>{{ t('peopleReport.to') }}<input v-model="form.periodTo" type="date" required></label></div>
        <label>{{ t('person.orgUnit') }}<select v-model="form.orgUnitId"><option value="">{{ t('dev.wholeNetwork') }}</option><option v-for="u in units" :key="u.id" :value="u.id">{{ u.name }}</option></select></label>
        <label>{{ t('dev.budget') }}<input v-model="form.budget" type="number" min="0" step="100"></label>
        <label>{{ t('assign.col.status') }}<select v-model="form.status"><option v-for="s in ['draft', 'active', 'closed']" :key="s" :value="s">{{ t(`dev.planStatus.${s}`) }}</option></select></label>
        <h3>{{ t('dev.planGoals') }}</h3>
        <div v-for="(g, i) in form.goals" :key="i" class="row"><input v-model="g.title" :placeholder="t('dev.goal')" class="grow"><input v-model="g.metric" :placeholder="t('dev.metric')"><input v-model="g.target" :placeholder="t('dev.target')" class="short"><button type="button" class="chip" @click="form.goals.splice(i, 1)">×</button></div>
        <button type="button" class="chip" @click="form.goals.push({ title: '', metric: '', target: '' })">+ {{ t('dev.goal') }}</button>
        <h3>KPI</h3>
        <div v-for="(k, i) in form.kpi" :key="i" class="row"><input v-model="k.name" :placeholder="t('dev.kpiName')" class="grow"><input v-model="k.target" :placeholder="t('dev.target')" class="short"><input v-model="k.unit" placeholder="%" class="short"><button type="button" class="chip" @click="form.kpi.splice(i, 1)">×</button></div>
        <button type="button" class="chip" @click="form.kpi.push({ name: '', target: '', unit: '' })">+ KPI</button>
        <div class="actions"><button type="button" class="chip" @click="editing = false">{{ t('common.cancel') }}</button><button type="submit" class="primary">{{ t('common.save') }}</button></div>
      </form>
    </div>
  </div>
</template>
<style scoped>
.head { display: flex; align-items: center; gap: var(--space-3); margin-bottom: var(--space-3); flex-wrap: wrap; }
h1 { margin: 0; font-weight: 900; }
h2 { margin: 0; font-weight: 800; }
h3 { margin: var(--space-2) 0 0; font-size: var(--font-size-body); color: var(--color-ink-muted); }
.list, .inner { list-style: none; margin: 0; padding: 0; display: grid; gap: var(--space-2); }
.inner { margin-top: var(--space-2); gap: var(--space-1); }
.card { background: var(--color-bg-soft); border-radius: var(--radius-m); padding: var(--space-3); }
.row { display: flex; gap: var(--space-2); align-items: center; flex-wrap: wrap; }
.grow { flex: 1; min-width: 160px; }
.short { width: 90px; }
.two { display: grid; grid-template-columns: 1fr 1fr; gap: var(--space-2); }
input, select { font: inherit; border: 1px solid var(--color-bg-line); border-radius: var(--radius-s); padding: var(--space-1) var(--space-2); background: var(--color-bg); color: var(--color-ink); min-width: 0; box-sizing: border-box; }
.modal label { display: grid; gap: var(--space-1); font-size: var(--font-size-body-s); color: var(--color-ink-muted); }
.badge { font-size: var(--font-size-body-s); font-weight: 700; border-radius: var(--radius-pill); padding: 2px var(--space-3); background: var(--color-bg-line-soft); }
.badge.active { background: var(--color-teal); color: var(--color-teal-deep); }
.chip { font: inherit; font-size: var(--font-size-body-s); font-weight: 700; border: 1px solid var(--color-bg-line); background: transparent; color: var(--color-ink-muted); border-radius: var(--radius-pill); padding: var(--space-1) var(--space-3); cursor: pointer; }
.chip.danger { color: var(--color-coral-ink); }
.primary { font: inherit; font-weight: 800; border: none; background: var(--color-sun); color: var(--color-ink); border-radius: var(--radius-pill); padding: var(--space-2) var(--space-4); cursor: pointer; }
.actions { display: flex; gap: var(--space-2); justify-content: flex-end; }
.sub { font-size: var(--font-size-body-s); color: var(--color-ink-faint); }
.error { color: var(--color-coral-ink); }
.overlay { position: fixed; inset: 0; background: rgb(0 0 0 / 40%); display: grid; place-items: center; padding: var(--space-3); z-index: 20; overflow: auto; }
.modal { background: var(--color-bg-soft); border-radius: var(--radius-l); padding: var(--space-4); display: grid; gap: var(--space-2); width: min(560px, 100%); box-sizing: border-box; max-height: 100%; overflow: auto; }
</style>
