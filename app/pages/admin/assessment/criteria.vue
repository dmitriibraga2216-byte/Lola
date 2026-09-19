<script setup lang="ts">
definePageMeta({ layout: 'admin', middleware: 'admin-scope', requiredScope: 'assessment.manage' })
const { t } = useI18n()
const { api } = useApi()
interface Scale { id: string, name: string, kind: string, options: { value: number, label: string, color?: string }[], passThreshold: string | null, allowNa: boolean }
interface Crit { id: string, text: string, description: string | null, scaleId: string, weight: string, isCritical: boolean, requiresCommentBelow: string | null, competencyId: string | null }
interface Group { id: string, name: string, description: string | null, weight: string, criteria: Crit[] }
interface Form { id: string, title: string, groupIds: string[], isActive: boolean }
const scales = ref<Scale[]>([])
const groups = ref<Group[]>([])
const forms = ref<Form[]>([])
const comps = ref<{ id: string, name: string }[]>([])
const error = ref('')
const notice = ref('')
const newGroup = reactive({ name: '', weight: 1 })
const newCrit = reactive<Record<string, { text: string, description: string, scaleId: string, weight: number, requiresCommentBelow: number | null, competencyId: string, isCritical: boolean }>>({})
const newForm = reactive({ title: '', groupIds: [] as string[] })
const newScale = reactive({ name: '', kind: 'ordinal', options: '1:Не відповідає,2:Частково,3:Відповідає,4:Вище очікувань,5:Взірець', passThreshold: 3 })
async function load() {
  try {
    scales.value = await api('/rating-scales'); groups.value = await api('/assessment/groups'); forms.value = await api('/assessment/forms'); comps.value = await api('/competencies')
    for (const g of groups.value) newCrit[g.id] ??= { text: '', description: '', scaleId: scales.value[0]?.id ?? '', weight: 1, requiresCommentBelow: null, competencyId: '', isCritical: false }
  } catch (err) { error.value = apiErrorOf(err).message }
}
onMounted(load)
async function run(fn: () => Promise<unknown>) { error.value = ''; notice.value = ''; try { await fn(); notice.value = t('common.saved'); await load() } catch (err) { error.value = apiErrorOf(err).message } }
const addGroup = () => run(async () => { await api('/assessment/groups', { method: 'PUT', body: { name: newGroup.name, weight: newGroup.weight } }); newGroup.name = '' })
const addCrit = (g: Group) => run(async () => { const c = newCrit[g.id]!; await api('/assessment/criteria', { method: 'PUT', body: { groupId: g.id, text: c.text, description: c.description || undefined, scaleId: c.scaleId, weight: c.weight, requiresCommentBelow: c.requiresCommentBelow, competencyId: c.competencyId || null, isCritical: c.isCritical } }); c.text = ''; c.description = '' })
const delCrit = (c: Crit) => run(() => api(`/assessment/criteria/${c.id}`, { method: 'DELETE' }))
const addForm = () => run(async () => { await api('/assessment/forms', { method: 'PUT', body: { title: newForm.title, groupIds: newForm.groupIds } }); newForm.title = ''; newForm.groupIds = [] })
const addScale = () => run(async () => {
  const options = newScale.options.split(',').map(s => s.trim()).filter(Boolean).map((s) => { const [v, l] = s.split(':'); return { value: Number(v), label: (l ?? v)!.trim() } })
  await api('/rating-scales', { method: 'PUT', body: { name: newScale.name, kind: newScale.kind, options, passThreshold: newScale.passThreshold } }); newScale.name = ''
})
const scaleName = (id: string) => scales.value.find(s => s.id === id)?.name ?? '?'
</script>
<template>
  <div>
    <h1>{{ t('admin.nav.assessCriteria') }}</h1>
    <p v-if="error" class="error">{{ error }}</p>
    <p v-if="notice" class="notice">{{ notice }}</p>

    <section class="card">
      <h2>{{ t('assess.scales') }}</h2>
      <p v-for="s in scales" :key="s.id" class="sub"><b>{{ s.name }}</b> ({{ s.kind }}): {{ s.options.map(o => `${o.value} ${o.label}`).join(' · ') }} · {{ t('assess.passFrom') }} {{ s.passThreshold ?? '—' }}</p>
      <div class="row">
        <input v-model="newScale.name" class="field" :placeholder="t('assess.scaleName')">
        <select v-model="newScale.kind" class="field"><option v-for="k in ['binary', 'ordinal', 'percent', 'letters']" :key="k" :value="k">{{ k }}</option></select>
        <input v-model="newScale.options" class="field grow" :placeholder="t('assess.scaleOptionsHint')">
        <input v-model.number="newScale.passThreshold" class="field short" type="number" step="0.5">
        <button class="chip" :disabled="!newScale.name" @click="addScale">+ {{ t('assess.scale') }}</button>
      </div>
    </section>

    <section v-for="g in groups" :key="g.id" class="card" :data-testid="`group-${g.id}`">
      <div class="row"><h2>{{ g.name }}</h2><span class="sub">{{ t('assess.weight') }} {{ g.weight }}</span></div>
      <table class="table">
        <tbody>
          <tr v-for="c in g.criteria" :key="c.id">
            <td><b>{{ c.text }}</b><div v-if="c.description" class="sub">{{ c.description }}</div></td>
            <td class="sub">{{ scaleName(c.scaleId) }} · ×{{ c.weight }}<template v-if="c.requiresCommentBelow != null"> · {{ t('assess.commentBelow') }} {{ c.requiresCommentBelow }}</template><template v-if="c.competencyId"> · {{ comps.find(x => x.id === c.competencyId)?.name }}</template></td>
            <td><button class="chip" @click="delCrit(c)">✕</button></td>
          </tr>
        </tbody>
      </table>
      <div v-if="newCrit[g.id]" class="row">
        <input v-model="newCrit[g.id]!.text" class="field grow" :placeholder="t('assess.critText')" :data-testid="`crit-text-${g.id}`">
        <input v-model="newCrit[g.id]!.description" class="field grow" :placeholder="t('assess.critHow')">
        <select v-model="newCrit[g.id]!.scaleId" class="field"><option v-for="s in scales" :key="s.id" :value="s.id">{{ s.name }}</option></select>
        <label class="sub">×<input v-model.number="newCrit[g.id]!.weight" class="field short" type="number" step="0.5" min="0.1"></label>
        <label class="sub">{{ t('assess.commentBelow') }} <input v-model.number="newCrit[g.id]!.requiresCommentBelow" class="field short" type="number" step="0.5"></label>
        <select v-model="newCrit[g.id]!.competencyId" class="field"><option value="">{{ t('assess.noCompetency') }}</option><option v-for="c in comps" :key="c.id" :value="c.id">{{ c.name }}</option></select>
        <button class="chip" :disabled="newCrit[g.id]!.text.length < 3" :data-testid="`crit-add-${g.id}`" @click="addCrit(g)">+ {{ t('assess.criterion') }}</button>
      </div>
    </section>

    <section class="card">
      <h2>{{ t('assess.newGroup') }}</h2>
      <div class="row">
        <input v-model="newGroup.name" class="field grow" :placeholder="t('assess.groupName')" data-testid="group-name">
        <label class="sub">{{ t('assess.weight') }} <input v-model.number="newGroup.weight" class="field short" type="number" step="0.5" min="0.1"></label>
        <button class="primary" :disabled="!newGroup.name" data-testid="group-add" @click="addGroup">{{ t('common.save') }}</button>
      </div>
    </section>

    <section class="card">
      <h2>{{ t('assess.forms') }}</h2>
      <p v-for="f in forms" :key="f.id" class="sub"><b>{{ f.title }}</b>: {{ f.groupIds.map(id => groups.find(g => g.id === id)?.name ?? '?').join(', ') }}</p>
      <div class="row">
        <input v-model="newForm.title" class="field grow" :placeholder="t('assess.formTitle')" data-testid="form-title">
        <label v-for="g in groups" :key="g.id" class="check"><input v-model="newForm.groupIds" type="checkbox" :value="g.id"> {{ g.name }}</label>
        <button class="primary" :disabled="newForm.title.length < 3 || !newForm.groupIds.length" data-testid="form-add" @click="addForm">{{ t('common.save') }}</button>
      </div>
    </section>
  </div>
</template>
<style scoped>
h1 { margin: 0 0 var(--space-4); font-weight: 900; }
h2 { margin: 0; font-weight: 800; }
.card { background: var(--color-bg-soft); border-radius: var(--radius-l); padding: var(--space-4); display: grid; gap: var(--space-3); margin-bottom: var(--space-3); }
.table { width: 100%; border-collapse: collapse; }
td { padding: var(--space-2) var(--space-2); border-bottom: 1px solid var(--color-bg-line-soft); vertical-align: top; }
.field, select { font: inherit; border: 1px solid var(--color-bg-line); border-radius: var(--radius-s); padding: var(--space-2) var(--space-3); background: var(--color-bg); color: var(--color-ink); }
.short { width: 70px; }
.grow { flex: 1; min-width: 160px; }
.row { display: flex; gap: var(--space-2); align-items: center; flex-wrap: wrap; }
.check { display: flex; gap: var(--space-1); align-items: center; font-size: var(--font-size-body-s); }
.chip { font: inherit; font-size: var(--font-size-body-s); font-weight: 700; border: 1px solid var(--color-bg-line); background: transparent; color: var(--color-ink-muted); border-radius: var(--radius-pill); padding: var(--space-1) var(--space-3); cursor: pointer; }
.primary { font: inherit; font-weight: 800; border: none; background: var(--color-sun); color: var(--color-ink); border-radius: var(--radius-pill); padding: var(--space-2) var(--space-4); cursor: pointer; }
.primary:disabled, .chip:disabled { opacity: 0.5; }
.sub { font-size: var(--font-size-body-s); color: var(--color-ink-faint); margin: 0; }
.error { color: var(--color-coral-ink); }
.notice { color: var(--color-teal-ink); }
</style>
