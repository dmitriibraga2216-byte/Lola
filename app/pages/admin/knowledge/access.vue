<script setup lang="ts">
/** Управління Базою знань (мокап KnowledgeAdmin, docs/21 §14): тумблер ограничения доступа и группы доступа таблицей. */
definePageMeta({ layout: 'admin', middleware: 'admin-scope', requiredScope: 'knowledge.manage' })
const { t } = useI18n()
const { api } = useApi()
interface G { id: string, name: string, description: string | null, appliesTo: string, contentCount: number, members: { subjectType: string, subjectId: string }[] }
const groups = ref<G[]>([])
const restrict = ref(true)
const error = ref('')
const adding = ref(false)
const form = reactive({ name: '', description: '', positionIds: [] as string[], orgUnitIds: [] as string[] })
const positions = ref<{ id: string, name: string }[]>([])
const units = ref<{ id: string, name: string }[]>([])
async function load() {
  try {
    groups.value = await api<G[]>('/access-groups', { query: { appliesTo: 'knowledge' } })
    restrict.value = (await api<{ restrictAccess: boolean }>('/settings/knowledge')).restrictAccess
    positions.value = await api('/refs/positions')
    units.value = (await api<{ units: { id: string, name: string }[] }>('/org/tree')).units ?? []
  } catch (err) { error.value = apiErrorOf(err).message }
}
onMounted(load)
async function toggleRestrict() { try { restrict.value = (await api<{ restrictAccess: boolean }>('/settings/knowledge', { method: 'PATCH', body: { restrictAccess: !restrict.value } })).restrictAccess } catch (err) { error.value = apiErrorOf(err).message } }
async function save() {
  error.value = ''
  try {
    await api('/access-groups', { method: 'POST', body: { name: form.name, description: form.description || null, appliesTo: 'knowledge', members: [...form.positionIds.map(id => ({ subjectType: 'position', subjectId: id })), ...form.orgUnitIds.map(id => ({ subjectType: 'org_unit', subjectId: id }))] } })
    Object.assign(form, { name: '', description: '', positionIds: [], orgUnitIds: [] }); adding.value = false
    await load()
  } catch (err) { error.value = apiErrorOf(err).message }
}
async function remove(g: G) { if (!confirm(t('common.confirmDelete'))) return; try { await api(`/access-groups/${g.id}`, { method: 'DELETE' }); await load() } catch (err) { error.value = apiErrorOf(err).message } }
</script>
<template>
  <div>
    <PageHeader :title="t('kbAdmin.title')" :crumbs="[{ label: t('admin.section.learning') }, { label: t('admin.section.info') }, { label: t('kbAdmin.title') }]">
      <template #actions><button class="btn primary" @click="adding = !adding">{{ t('kbAdmin.addGroup') }}</button></template>
    </PageHeader>
    <p v-if="error" class="error-text" role="alert">{{ error }}</p>
    <label class="toggle block"><input type="checkbox" :checked="restrict" @change="toggleRestrict"><span>{{ t('kbAdmin.restrict') }}<span class="hint">{{ t('kbAdmin.restrictHint') }}</span></span></label>
    <section v-if="adding" class="card form">
      <label class="label" for="g-name">{{ t('kbAdmin.col.name') }}</label><input id="g-name" v-model="form.name" class="field" maxlength="120">
      <label class="label top" for="g-desc">{{ t('kbAdmin.col.description') }}</label><input id="g-desc" v-model="form.description" class="field" maxlength="500">
      <p class="label top">{{ t('kbAdmin.positions') }}</p>
      <div class="chips"><label v-for="p in positions" :key="p.id" :class="['chip', { on: form.positionIds.includes(p.id) }]"><input v-model="form.positionIds" type="checkbox" :value="p.id" class="sr">{{ p.name }}</label></div>
      <p class="label top">{{ t('kbAdmin.units') }}</p>
      <div class="chips"><label v-for="u in units" :key="u.id" :class="['chip', { on: form.orgUnitIds.includes(u.id) }]"><input v-model="form.orgUnitIds" type="checkbox" :value="u.id" class="sr">{{ u.name }}</label></div>
      <div class="actions top"><button class="btn primary" :disabled="!form.name.trim()" @click="save">{{ t('common.save') }}</button><button class="btn ghost" @click="adding = false">{{ t('common.cancel') }}</button></div>
    </section>
    <div class="table-wrap">
      <table class="table">
        <thead><tr><th>{{ t('kbAdmin.col.name') }}</th><th>{{ t('kbAdmin.col.description') }}</th><th class="num">{{ t('kbAdmin.col.resources') }}</th><th>{{ t('kbAdmin.col.access') }}</th><th /></tr></thead>
        <tbody>
          <tr v-for="g in groups" :key="g.id">
            <td><b>{{ g.name }}</b><span class="sub">{{ t('kbAdmin.members', { n: g.members.length }) }}</span></td>
            <td>{{ g.description ?? '—' }}</td>
            <td class="num">{{ g.contentCount }}</td>
            <td><span :class="['badge', restrict ? 'coral' : 'muted']">{{ restrict ? t('kbAdmin.restricted') : t('kbAdmin.open') }}</span></td>
            <td><button class="chip" @click="remove(g)">{{ t('common.delete') }}</button></td>
          </tr>
          <tr v-if="!groups.length"><td colspan="5" class="faint">{{ t('kbAdmin.empty') }}</td></tr>
        </tbody>
      </table>
    </div>
  </div>
</template>
<style scoped>
.block { margin-bottom: var(--space-4); }
.form { margin-bottom: var(--space-4); }
.top { margin-top: var(--space-3); }
.actions { display: flex; gap: var(--space-2); }
.sr { position: absolute; opacity: 0; width: 1px; height: 1px; }
.chip { cursor: pointer; }
</style>
