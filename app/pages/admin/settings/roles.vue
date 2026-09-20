<script setup lang="ts">
/**
 * Ролі та права (мокап Roles, docs/24 §3.5, Г-24.1): слева таблица ролей (Скоупів · Людей · Тип),
 * справа редактор — группы скоупов чекбоксами с кодами, «Створити роль». Защиты объясняет сервер.
 */
definePageMeta({ layout: 'admin', middleware: 'admin-scope', requiredScope: 'settings.tenant' })
const { t } = useI18n()
const { api } = useApi()
const { hasScope, startPreview } = useAuth()

interface Role { id: string, code: string, name: string, description: string | null, scopes: string[], isSystem: boolean, defaultScopeType: string, peopleCount: number }
interface Group { key: string, scopes: string[] }

const roles = ref<Role[]>([])
const groups = ref<Group[]>([])
const selected = ref<Role | null>(null)
const creating = ref(false)
const form = reactive({ code: '', name: '', description: '', scopes: [] as string[], defaultScopeType: 'location' })
const error = ref('')
const saved = ref(false)
const q = ref('')

async function load() {
  const r = await api<Role[] & { groups: Group[] }>('/settings/roles')
  roles.value = [...r]
  groups.value = r.groups
}
onMounted(load)

function select(r: Role) {
  selected.value = r; creating.value = false; error.value = ''; saved.value = false
  Object.assign(form, { code: r.code, name: r.name, description: r.description ?? '', scopes: [...r.scopes], defaultScopeType: r.defaultScopeType })
}
function startCreate() {
  selected.value = null; creating.value = true; error.value = ''; saved.value = false
  Object.assign(form, { code: '', name: '', description: '', scopes: ['learn.view', 'learn.attempt', 'report.own'], defaultScopeType: 'location' })
}
const visibleGroups = computed(() => groups.value.map(g => ({ ...g, scopes: g.scopes.filter(s => !q.value || s.includes(q.value.toLowerCase()) || t(`settings.scopes.${s}`).toLowerCase().includes(q.value.toLowerCase())) })).filter(g => g.scopes.length))
const allIn = (g: Group) => g.scopes.every(s => form.scopes.includes(s))
function toggleGroup(g: Group) {
  if (allIn(g)) form.scopes = form.scopes.filter(s => !g.scopes.includes(s))
  else form.scopes = [...new Set([...form.scopes, ...g.scopes])]
}
const adminLocked = computed(() => selected.value?.code === 'admin')

async function save() {
  error.value = ''; saved.value = false
  try {
    if (creating.value) {
      const r = await api<Role>('/settings/roles', { method: 'POST', body: { code: form.code, name: form.name, description: form.description || null, scopes: form.scopes, defaultScopeType: form.defaultScopeType } })
      await load(); select(roles.value.find(x => x.id === r.id)!)
    }
    else if (selected.value) {
      const body: Record<string, unknown> = { name: form.name, description: form.description || null, defaultScopeType: form.defaultScopeType }
      if (!adminLocked.value) body.scopes = form.scopes
      const r = await api<Role>(`/settings/roles/${selected.value.id}`, { method: 'PATCH', body })
      await load(); select(roles.value.find(x => x.id === r.id)!)
    }
    saved.value = true
  }
  catch (err) { error.value = apiErrorOf(err).message }
}
async function remove() {
  if (!selected.value || !confirm(t('settings.roles.confirmDelete', { name: selected.value.name }))) return
  error.value = ''
  try { await api(`/settings/roles/${selected.value.id}`, { method: 'DELETE' }); selected.value = null; await load() }
  catch (err) { error.value = apiErrorOf(err).message }
}
/** «Переглянути систему як роль» (docs/24 §3.5): не змінює власних прав, лише показує екрани очима цієї ролі. */
async function previewAs(r: Role) {
  error.value = ''
  try { await startPreview(r.id) }
  catch (err) { error.value = apiErrorOf(err).message }
}
</script>

<template>
  <div>
    <PageHeader :title="t('settings.roles.title')" :crumbs="[{ label: t('admin.section.settings') }, { label: t('settings.roles.title') }]">
      <template #actions>
        <button class="btn ghost" type="button" @click="startCreate">{{ t('settings.roles.create') }}</button>
        <button v-if="selected || creating" class="btn primary" type="button" :disabled="!form.name || (creating && !form.code) || !form.scopes.length" @click="save">{{ t('common.save') }}</button>
      </template>
    </PageHeader>
    <p v-if="error" class="error-text" role="alert">{{ error }}</p>
    <p v-if="saved" class="note teal" role="status">{{ t('common.saved') }}</p>

    <div class="layout">
      <div class="table-wrap card list">
        <table class="table">
          <thead><tr><th>{{ t('settings.roles.role') }}</th><th>{{ t('settings.roles.scopesCount') }}</th><th>{{ t('settings.roles.peopleCount') }}</th><th>{{ t('settings.roles.type') }}</th></tr></thead>
          <tbody>
            <tr v-for="r in roles" :key="r.id" :class="{ on: selected?.id === r.id }" tabindex="0" @click="select(r)" @keydown.enter="select(r)">
              <td><b>{{ r.name }}</b><br><code class="muted">{{ r.code }}</code></td>
              <td>{{ r.scopes.length }}</td>
              <td>{{ r.peopleCount }}</td>
              <td><span class="badge" :class="r.isSystem ? 'muted' : 'teal'">{{ r.isSystem ? t('settings.roles.system') : t('settings.roles.custom') }}</span></td>
            </tr>
          </tbody>
        </table>
      </div>

      <aside v-if="selected || creating" class="card editor">
        <div class="ehead">
          <h2 class="panel-title">{{ creating ? t('settings.roles.newRole') : form.name }}</h2>
          <button v-if="selected" class="btn ghost small" type="button" @click="previewAs(selected)">{{ t('settings.roles.previewAs') }}</button>
        </div>
        <p v-if="selected" class="help">{{ t('settings.roles.scopeLine', { scope: t(`settings.scopeTypes.${selected.defaultScopeType}`), n: selected.peopleCount }) }}</p>
        <div class="two">
          <div><label class="label" for="r-name">{{ t('settings.roles.name') }}</label><input id="r-name" v-model="form.name" class="field" maxlength="80"></div>
          <div><label class="label" for="r-code">{{ t('settings.roles.code') }}</label><input id="r-code" v-model="form.code" class="field" maxlength="40" pattern="[a-z_]{3,40}" :disabled="!creating"><p class="help">{{ t('settings.roles.codeHint') }}</p></div>
        </div>
        <label class="label top" for="r-desc">{{ t('settings.roles.description') }}</label><input id="r-desc" v-model="form.description" class="field" maxlength="500">
        <p class="label top">{{ t('settings.roles.defaultScope') }}</p>
        <div class="segmented">
          <button v-for="s in ['tenant', 'org_unit', 'location']" :key="s" type="button" :class="{ on: form.defaultScopeType === s }" @click="form.defaultScopeType = s">{{ t(`settings.scopeTypes.${s}`) }}</button>
        </div>
        <p v-if="adminLocked" class="note sun top">{{ t('settings.roles.adminReadonly') }}</p>
        <input v-model="q" class="field top" type="search" :placeholder="t('settings.roles.searchScope')" :aria-label="t('settings.roles.searchScope')">
        <div v-for="g in visibleGroups" :key="g.key" class="group">
          <div class="ghead">
            <span class="gtitle">{{ t(`settings.roles.group.${g.key}`) }}</span>
            <button type="button" class="link" :disabled="adminLocked" @click="toggleGroup(g)">{{ allIn(g) ? t('settings.roles.clearGroup') : t('settings.roles.selectGroup') }}</button>
          </div>
          <label v-for="s in g.scopes" :key="s" class="scope" :class="{ na: !hasScope(s) }">
            <input v-model="form.scopes" type="checkbox" :value="s" :disabled="adminLocked || (!hasScope(s) && !form.scopes.includes(s))">
            <span>{{ t(`settings.scopes.${s}`) }}</span><code>{{ s }}</code>
          </label>
        </div>
        <div v-if="selected && !selected.isSystem" class="top"><button class="btn danger small" type="button" @click="remove">{{ t('settings.roles.delete') }}</button></div>
      </aside>
    </div>
  </div>
</template>

<style scoped>
.layout { display: grid; grid-template-columns: minmax(0, 1fr) minmax(320px, 480px); gap: var(--space-4); align-items: start; }
.list tr { cursor: pointer; }
.list tr.on td { background: var(--color-sun-soft); }
.editor { display: grid; gap: var(--space-2); }
.ehead { display: flex; justify-content: space-between; align-items: center; gap: var(--space-2); flex-wrap: wrap; }
.two { display: grid; grid-template-columns: 1fr 1fr; gap: var(--space-3); }
.top { margin-top: var(--space-3); }
.group { border-top: 1px solid var(--color-bg-line-soft); padding-top: var(--space-2); }
.ghead { display: flex; justify-content: space-between; align-items: center; margin-bottom: var(--space-1); }
.gtitle { font-size: 12px; font-weight: 800; letter-spacing: 0.06em; text-transform: uppercase; color: var(--color-ink-muted); }
.link { font: inherit; border: none; background: transparent; cursor: pointer; }
.scope { display: grid; grid-template-columns: auto 1fr auto; gap: var(--space-2); align-items: center; padding: var(--space-1) 0; }
.scope code { font-size: 12px; color: var(--color-ink-faint); }
.scope.na { opacity: 0.6; }
@media (max-width: 900px) { .layout, .two { grid-template-columns: 1fr; } }
</style>
