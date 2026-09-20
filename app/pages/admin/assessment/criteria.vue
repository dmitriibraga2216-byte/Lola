<script setup lang="ts">
/**
 * Групи критеріїв за мокапом CriteriaGroups: одна бібліотека на всю установку — анкета лише посилається на критерій.
 * Картка групи: назва · мітки · «N критеріїв» · критерії списком; праворуч — «Де використовуються».
 * Шкали живуть у налаштуваннях (`/admin/settings/scales`, docs/24 Г-24.4).
 */
definePageMeta({ layout: 'admin', middleware: 'admin-scope', requiredScope: 'assessment.manage' })
const { t } = useI18n()
const { api } = useApi()
interface Crit { id: string, text: string, description: string | null, weight: string, isCritical: boolean, competencyId: string | null, usedInForms: number, usedInChecklists: number }
interface Group { id: string, name: string, description: string | null, weight: string, tags: string[], criteria: Crit[] }
const groups = ref<Group[]>([])
const usage = ref<{ forms: number, checklists: number, competencies: number } | null>(null)
const comps = ref<{ id: string, name: string }[]>([])
const error = ref('')
const notice = ref('')
const open = ref<string | null>(null)
const newGroup = reactive({ name: '', tags: '', weight: 1 })
const newCrit = reactive<Record<string, { text: string, description: string, weight: number, competencyId: string, isCritical: boolean }>>({})
async function load() {
  try {
    groups.value = await api('/assessment/groups'); usage.value = await api('/assessment/groups/usage'); comps.value = await api('/competencies')
    for (const g of groups.value) newCrit[g.id] ??= { text: '', description: '', weight: 1, competencyId: '', isCritical: false }
  }
  catch (err) { error.value = apiErrorOf(err).message }
}
onMounted(load)
async function run(fn: () => Promise<unknown>) { error.value = ''; notice.value = ''; try { await fn(); notice.value = t('common.saved'); await load() } catch (err) { error.value = apiErrorOf(err).message } }
const addGroup = () => run(async () => { await api('/assessment/groups', { method: 'PUT', body: { name: newGroup.name, weight: newGroup.weight, tags: newGroup.tags.split(',').map(s => s.trim()).filter(Boolean) } }); newGroup.name = ''; newGroup.tags = '' })
const addCrit = (g: Group) => run(async () => { const c = newCrit[g.id]!; await api('/assessment/criteria', { method: 'PUT', body: { groupId: g.id, text: c.text, description: c.description || null, weight: c.weight, competencyId: c.competencyId || null, isCritical: c.isCritical } }); c.text = ''; c.description = '' })
const delCrit = (c: Crit) => run(() => api(`/assessment/criteria/${c.id}`, { method: 'DELETE' }))
</script>
<template>
  <div>
    <PageHeader :title="t('assess.criteriaGroups')" :crumbs="[{ label: t('assess.sectionTitle') }, { label: t('assess.dictionary') }]">
      <template #actions><NuxtLink to="/admin/settings/scales" class="btn ghost">{{ t('assess.scales') }}</NuxtLink></template>
    </PageHeader>
    <p v-if="error" class="note coral">{{ error }}</p>
    <p v-if="notice" class="note teal">{{ notice }}</p>

    <div class="layout">
      <div class="list">
        <article v-for="g in groups" :key="g.id" class="card group" :data-testid="`group-${g.id}`">
          <header class="ghead" @click="open = open === g.id ? null : g.id">
            <h2>{{ g.name }}</h2>
            <span v-for="tag in g.tags" :key="tag" class="chip">{{ tag }}</span>
            <span class="count">{{ t('assess.criteriaN', { n: g.criteria.length }) }}</span>
          </header>
          <p class="crits">{{ g.criteria.map(c => c.text).join(' · ') || t('assess.noCriteria') }}</p>
          <div v-if="open === g.id" class="details">
            <table class="table plain">
              <tbody>
                <tr v-for="c in g.criteria" :key="c.id">
                  <td><b>{{ c.text }}</b><span v-if="c.description" class="sub">{{ c.description }}</span></td>
                  <td class="sub">{{ t('assess.weight') }} {{ c.weight }}<template v-if="c.isCritical"> · {{ t('cl.critical') }}</template><template v-if="c.competencyId"> · {{ comps.find(x => x.id === c.competencyId)?.name }}</template></td>
                  <td class="sub">{{ t('assess.usedIn', { forms: c.usedInForms, checklists: c.usedInChecklists }) }}</td>
                  <td><button class="chip" :aria-label="t('common.delete')" @click="delCrit(c)">✕</button></td>
                </tr>
              </tbody>
            </table>
            <div class="row">
              <input v-model="newCrit[g.id]!.text" class="field grow" :placeholder="t('assess.critText')" :data-testid="`crit-text-${g.id}`">
              <input v-model="newCrit[g.id]!.description" class="field grow" :placeholder="t('assess.critHow')">
              <input v-model.number="newCrit[g.id]!.weight" class="field short" type="number" step="0.5" min="0.1" :aria-label="t('assess.weight')">
              <select v-model="newCrit[g.id]!.competencyId" class="field"><option value="">{{ t('assess.noCompetency') }}</option><option v-for="c in comps" :key="c.id" :value="c.id">{{ c.name }}</option></select>
              <label class="check"><input v-model="newCrit[g.id]!.isCritical" type="checkbox"> {{ t('cl.critical') }}</label>
              <button class="chip outline" :disabled="!newCrit[g.id]!.text" :data-testid="`crit-add-${g.id}`" @click="addCrit(g)">+ {{ t('assess.criterion') }}</button>
            </div>
          </div>
        </article>
        <section class="card">
          <h2 class="panel-title">{{ t('assess.newGroup') }}</h2>
          <div class="row">
            <input v-model="newGroup.name" class="field grow" :placeholder="t('assess.groupName')" data-testid="group-name">
            <input v-model="newGroup.tags" class="field" :placeholder="t('assess.tagsHint')">
            <label class="sub">{{ t('assess.weight') }} <input v-model.number="newGroup.weight" class="field short" type="number" step="0.5" min="0.1"></label>
            <button class="btn primary small" :disabled="!newGroup.name" data-testid="group-add" @click="addGroup">{{ t('assess.addGroup') }}</button>
          </div>
        </section>
      </div>
      <aside class="card usage">
        <h2 class="panel-title">{{ t('assess.whereUsed') }}</h2>
        <p class="help">{{ t('assess.oneLibrary') }}</p>
        <ul v-if="usage">
          <li><span>{{ t('assess.inForms') }}</span><b>{{ usage.forms }}</b></li>
          <li><span>{{ t('assess.inChecklists') }}</span><b>{{ usage.checklists }}</b></li>
          <li><span>{{ t('assess.linkedCompetencies') }}</span><b>{{ usage.competencies }}</b></li>
        </ul>
      </aside>
    </div>
  </div>
</template>
<style scoped>
.layout { display: grid; grid-template-columns: minmax(0, 1fr) 300px; gap: var(--space-4); align-items: start; }
@media (max-width: 900px) { .layout { grid-template-columns: 1fr; } }
.list { display: grid; gap: var(--space-3); }
.group { display: grid; gap: var(--space-2); }
.ghead { display: flex; flex-wrap: wrap; align-items: center; gap: var(--space-2); cursor: pointer; }
h2 { margin: 0; font-weight: 900; font-size: var(--font-size-body); }
.count { margin-left: auto; color: var(--color-ink-muted); font-weight: 700; font-size: var(--font-size-body-s); }
.crits { margin: 0; color: var(--color-ink-muted); font-size: var(--font-size-body-s); line-height: 1.5; }
.details { display: grid; gap: var(--space-2); }
.row { display: flex; gap: var(--space-2); align-items: center; flex-wrap: wrap; }
.field { width: auto; }
.grow { flex: 1; min-width: 160px; }
.short { width: 72px; }
.check { display: flex; gap: var(--space-1); align-items: center; font-size: var(--font-size-body-s); }
.usage ul { list-style: none; margin: 0; padding: 0; display: grid; gap: var(--space-2); }
.usage li { display: flex; justify-content: space-between; font-weight: 700; }
.usage b { font-size: 22px; font-weight: 900; }
.note { margin: 0 0 var(--space-3); }
</style>
