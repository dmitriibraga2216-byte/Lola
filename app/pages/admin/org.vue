<script setup lang="ts">
definePageMeta({ layout: 'admin', middleware: 'admin-scope', requiredScope: 'people.view' })
const { t } = useI18n()
const { api, apiRaw } = useApi()
const { hasScope } = useAuth()

interface Unit { id: string, name: string, parentId: string | null, path: string }
interface Loc { id: string, name: string, orgUnitId: string, address: string | null, cityId: string | null, managerId: string | null, isActive: boolean }
interface TreeUnit { id: string, children: TreeUnit[], locations: { id: string, people: unknown[] }[] }
interface Ref { id: string, name: string }
interface Chief { id: string, kind: string, scope: string | null, user_id: string, user_name: string, chief_id: string, chief_name: string }

const mode = ref<'tree' | 'chiefs'>('tree')
const units = ref<Unit[]>([])
const locs = ref<Loc[]>([])
const counts = ref<Record<string, number>>({})
const cities = ref<Ref[]>([])
const error = ref('')
const notice = ref('')
const busy = ref(false)
const canEdit = computed(() => hasScope('settings.tenant'))

const selected = ref<{ kind: 'unit' | 'location', id: string } | null>(null)
const form = reactive({ name: '', parentId: '', orgUnitId: '', address: '', cityId: '', managerName: '', managerId: '', isActive: true })
const newUnit = reactive({ name: '', parentId: '' })
const newLoc = reactive({ name: '', orgUnitId: '' })

async function load() {
  try {
    const [u, l, tree, c] = await Promise.all([api<Unit[]>('/refs/org-units'), api<Loc[]>('/refs/locations'), api<{ units: TreeUnit[] }>('/org/tree'), api<Ref[]>('/refs/cities')])
    units.value = u
    locs.value = l
    cities.value = c
    const cnt: Record<string, number> = {}
    const walk = (list: TreeUnit[]): number => list.reduce((sum, x) => {
      const own = x.locations.reduce((s, loc) => { cnt[loc.id] = loc.people.length; return s + loc.people.length }, 0)
      const total = own + walk(x.children)
      cnt[x.id] = total
      return sum + total
    }, 0)
    walk(tree.units)
    counts.value = cnt
  }
  catch (err) { error.value = apiErrorOf(err).message }
}
onMounted(load)

const childrenOf = (parentId: string | null) => units.value.filter(u => u.parentId === parentId)
const managerName = ref<Record<string, string>>({})

function select(kind: 'unit' | 'location', id: string) {
  selected.value = { kind, id }
  if (kind === 'unit') {
    const u = units.value.find(x => x.id === id)!
    Object.assign(form, { name: u.name, parentId: u.parentId ?? '', orgUnitId: '', address: '', cityId: '', managerId: '', isActive: true })
  }
  else {
    const l = locs.value.find(x => x.id === id)!
    Object.assign(form, { name: l.name, parentId: '', orgUnitId: l.orgUnitId, address: l.address ?? '', cityId: l.cityId ?? '', managerId: l.managerId ?? '', managerName: l.managerId ? managerName.value[l.managerId] ?? '' : '', isActive: l.isActive })
  }
}

async function run(fn: () => Promise<unknown>, done = t('common.saved')) {
  busy.value = true
  error.value = ''
  notice.value = ''
  try { await fn(); notice.value = done; await load() }
  catch (err) { error.value = apiErrorOf(err).message }
  finally { busy.value = false }
}
const save = () => run(async () => {
  if (!selected.value) return
  if (selected.value.kind === 'unit') await api(`/refs/org-units/${selected.value.id}`, { method: 'PATCH', body: { name: form.name, parentId: form.parentId || null } })
  else await api(`/refs/locations/${selected.value.id}`, { method: 'PATCH', body: { name: form.name, orgUnitId: form.orgUnitId, address: form.address || null, cityId: form.cityId || null, managerId: form.managerId || null, isActive: form.isActive } })
})
const remove = () => run(async () => {
  if (!selected.value) return
  await api(`/refs/${selected.value.kind === 'unit' ? 'org-units' : 'locations'}/${selected.value.id}`, { method: 'DELETE' })
  selected.value = null
})
const createUnit = () => run(async () => { await api('/refs/org-units', { method: 'POST', body: { name: newUnit.name, ...(newUnit.parentId ? { parentId: newUnit.parentId } : {}) } }); newUnit.name = '' })
const createLoc = () => run(async () => { await api('/refs/locations', { method: 'POST', body: { name: newLoc.name, orgUnitId: newLoc.orgUnitId } }); newLoc.name = '' })

// Перетаскивание (docs/16 §5.3): подразделение или точка → на подразделение
const dragging = ref<{ kind: 'unit' | 'location', id: string } | null>(null)
const dragOver = ref<string | null>(null)
function onDragStart(kind: 'unit' | 'location', id: string, e: DragEvent) { dragging.value = { kind, id }; e.dataTransfer?.setData('text/plain', id) }
function onDrop(targetUnitId: string) {
  const d = dragging.value
  dragging.value = null
  dragOver.value = null
  if (!d || !canEdit.value || d.id === targetUnitId) return
  run(() => d.kind === 'unit'
    ? api(`/refs/org-units/${d.id}`, { method: 'PATCH', body: { parentId: targetUnitId } })
    : api(`/refs/locations/${d.id}`, { method: 'PATCH', body: { orgUnitId: targetUnitId } }), t('orgAdmin.moved'))
}

// Поиск людей для руководителя точки и матрицы
const search = ref('')
const found = ref<{ id: string, fullName: string }[]>([])
let timer: ReturnType<typeof setTimeout>
watch(search, (v) => {
  clearTimeout(timer)
  if (!v.trim()) { found.value = []; return }
  timer = setTimeout(async () => {
    try { found.value = (await apiRaw<{ data: { id: string, fullName: string }[] }>('/people', { query: { q: v, tab: 'active', limit: 8 } })).data }
    catch { found.value = [] }
  }, 300)
})

// Функциональные руководители (docs/16 §3.5)
const chiefs = ref<Chief[]>([])
const chiefForm = reactive({ userId: '', userName: '', chiefId: '', chiefName: '', kind: 'functional' as 'line' | 'functional', scope: '' })
const pick = ref<'user' | 'chief' | 'manager' | null>(null)
async function loadChiefs() { try { chiefs.value = await api('/functional-chiefs') } catch (err) { error.value = apiErrorOf(err).message } }
watch(mode, v => v === 'chiefs' && loadChiefs())
function choose(p: { id: string, fullName: string }) {
  if (pick.value === 'user') { chiefForm.userId = p.id; chiefForm.userName = p.fullName }
  else if (pick.value === 'chief') { chiefForm.chiefId = p.id; chiefForm.chiefName = p.fullName }
  else if (pick.value === 'manager') { form.managerId = p.id; form.managerName = p.fullName; managerName.value[p.id] = p.fullName }
  pick.value = null
  search.value = ''
  found.value = []
}
const addChief = () => run(async () => { await api('/functional-chiefs', { method: 'PUT', body: { userId: chiefForm.userId, chiefId: chiefForm.chiefId, kind: chiefForm.kind, scope: chiefForm.scope || undefined } }); Object.assign(chiefForm, { userId: '', userName: '', chiefId: '', chiefName: '', scope: '' }); await loadChiefs() })
const removeChief = (id: string) => run(async () => { await api(`/functional-chiefs/${id}`, { method: 'DELETE' }); await loadChiefs() })
</script>

<template>
  <div>
    <header class="head">
      <h1>{{ t('orgAdmin.title') }}</h1>
      <div class="tabs" role="tablist">
        <button role="tab" :aria-selected="mode === 'tree'" :class="['tab', { on: mode === 'tree' }]" @click="mode = 'tree'">{{ t('orgAdmin.tree') }}</button>
        <button role="tab" :aria-selected="mode === 'chiefs'" :class="['tab', { on: mode === 'chiefs' }]" @click="mode = 'chiefs'">{{ t('orgAdmin.chiefs') }}</button>
      </div>
    </header>
    <p v-if="error" class="error" role="alert">{{ error }}</p>
    <p v-if="notice" class="notice" role="status">{{ notice }}</p>

    <div v-if="mode === 'tree'" class="layout">
      <section class="card tree">
        <p v-if="canEdit" class="sub">{{ t('orgAdmin.moveHint') }}</p>
        <ul class="units">
          <li v-for="u in childrenOf(null)" :key="u.id">
            <OrgAdminNode :unit="u" :units="units" :locs="locs" :counts="counts" :selected="selected" :can-edit="canEdit" :drag-over="dragOver" @select="select" @drag-start="onDragStart" @drop-on="onDrop" @drag-over="dragOver = $event" />
          </li>
        </ul>
        <div v-if="canEdit" class="new">
          <form class="row" @submit.prevent="createUnit">
            <input v-model="newUnit.name" :placeholder="t('orgAdmin.newUnit')" :aria-label="t('orgAdmin.newUnit')" required>
            <select v-model="newUnit.parentId" :aria-label="t('orgAdmin.parent')"><option value="">{{ t('orgAdmin.root') }}</option><option v-for="u in units" :key="u.id" :value="u.id">{{ u.name }}</option></select>
            <button class="btn" :disabled="busy">+</button>
          </form>
          <form class="row" @submit.prevent="createLoc">
            <input v-model="newLoc.name" :placeholder="t('orgAdmin.newLocation')" :aria-label="t('orgAdmin.newLocation')" required>
            <select v-model="newLoc.orgUnitId" :aria-label="t('orgAdmin.unit')" required><option value="" disabled>{{ t('orgAdmin.unit') }}</option><option v-for="u in units" :key="u.id" :value="u.id">{{ u.name }}</option></select>
            <button class="btn" :disabled="busy || !newLoc.orgUnitId">+</button>
          </form>
        </div>
      </section>

      <aside class="card side">
        <p v-if="!selected" class="sub">{{ t('orgAdmin.select') }}</p>
        <form v-else class="form" @submit.prevent="save">
          <h2>{{ selected.kind === 'unit' ? t('orgAdmin.unit') : t('orgAdmin.location') }} · {{ t('orgAdmin.peopleCount', { n: counts[selected.id] ?? 0 }) }}</h2>
          <label>{{ t('orgAdmin.rename') }}<input v-model="form.name" required maxlength="120" :disabled="!canEdit"></label>
          <label v-if="selected.kind === 'unit'">{{ t('orgAdmin.parent') }}<select v-model="form.parentId" :disabled="!canEdit"><option value="">{{ t('orgAdmin.root') }}</option><option v-for="u in units.filter(x => x.id !== selected!.id)" :key="u.id" :value="u.id">{{ u.name }}</option></select></label>
          <template v-else>
            <label>{{ t('orgAdmin.unit') }}<select v-model="form.orgUnitId" :disabled="!canEdit"><option v-for="u in units" :key="u.id" :value="u.id">{{ u.name }}</option></select></label>
            <label>{{ t('orgAdmin.city') }}<select v-model="form.cityId" :disabled="!canEdit"><option value="">—</option><option v-for="c in cities" :key="c.id" :value="c.id">{{ c.name }}</option></select></label>
            <label>{{ t('orgAdmin.address') }}<input v-model="form.address" maxlength="300" :disabled="!canEdit"></label>
            <label>{{ t('orgAdmin.manager') }}<input :value="form.managerName || (form.managerId ? form.managerId.slice(0, 8) : '')" readonly :placeholder="t('orgAdmin.searchPerson')" @focus="pick = 'manager'"></label>
            <input v-if="pick === 'manager'" v-model="search" type="search" :placeholder="t('orgAdmin.searchPerson')" :aria-label="t('orgAdmin.searchPerson')">
            <ul v-if="pick === 'manager' && found.length" class="found"><li v-for="p in found" :key="p.id"><button type="button" class="btn small" @click="choose(p)">{{ p.fullName }}</button></li></ul>
            <label class="check"><input v-model="form.isActive" type="checkbox" :disabled="!canEdit"> {{ t('groups.active') }}</label>
          </template>
          <NuxtLink v-if="selected.kind === 'unit'" :to="{ path: '/admin/people', query: { orgUnitId: selected.id } }" class="link">{{ t('admin.nav.people') }} →</NuxtLink>
          <div v-if="canEdit" class="actions">
            <button type="button" class="btn danger" :disabled="busy" @click="remove">{{ t('orgAdmin.delete') }}</button>
            <button type="submit" class="btn primary" :disabled="busy">{{ t('common.save') }}</button>
          </div>
        </form>
      </aside>
    </div>

    <div v-else class="card">
      <table v-if="chiefs.length" class="table">
        <thead><tr><th>{{ t('orgAdmin.subordinate') }}</th><th>{{ t('orgAdmin.chief') }}</th><th>{{ t('orgAdmin.kind') }}</th><th>{{ t('orgAdmin.scopeLabel') }}</th><th /></tr></thead>
        <tbody><tr v-for="c in chiefs" :key="c.id"><td>{{ c.user_name }}</td><td>{{ c.chief_name }}</td><td>{{ t(`orgAdmin.${c.kind}`) }}</td><td class="sub">{{ c.scope || '—' }}</td><td><button v-if="hasScope('people.edit')" class="btn small" :disabled="busy" @click="removeChief(c.id)">×</button></td></tr></tbody>
      </table>
      <p v-else class="sub">{{ t('orgAdmin.noChiefs') }}</p>
      <form v-if="hasScope('people.edit')" class="form chief-form" @submit.prevent="addChief">
        <h2>{{ t('orgAdmin.addChief') }}</h2>
        <div class="row">
          <button type="button" class="btn" @click="pick = 'user'">{{ t('orgAdmin.subordinate') }}: {{ chiefForm.userName || '…' }}</button>
          <button type="button" class="btn" @click="pick = 'chief'">{{ t('orgAdmin.chief') }}: {{ chiefForm.chiefName || '…' }}</button>
          <select v-model="chiefForm.kind" :aria-label="t('orgAdmin.kind')"><option value="functional">{{ t('orgAdmin.functional') }}</option><option value="line">{{ t('orgAdmin.line') }}</option></select>
          <input v-model="chiefForm.scope" :placeholder="t('orgAdmin.scopeLabel')" maxlength="120">
          <button class="btn primary" :disabled="busy || !chiefForm.userId || !chiefForm.chiefId">+</button>
        </div>
        <template v-if="pick === 'user' || pick === 'chief'">
          <input v-model="search" type="search" :placeholder="t('orgAdmin.searchPerson')" :aria-label="t('orgAdmin.searchPerson')">
          <ul v-if="found.length" class="found"><li v-for="p in found" :key="p.id"><button type="button" class="btn small" @click="choose(p)">{{ p.fullName }}</button></li></ul>
        </template>
      </form>
    </div>
  </div>
</template>

<style scoped>
.head { display: flex; align-items: center; gap: var(--space-3); margin-bottom: var(--space-3); flex-wrap: wrap; }
h1 { margin: 0; font-weight: 900; }
h2 { margin: 0; font-size: var(--font-size-body); font-weight: 800; }
.tabs { display: flex; gap: var(--space-2); }
.tab { font: inherit; font-weight: 700; border: 1px solid var(--color-bg-line); background: transparent; color: var(--color-ink-muted); border-radius: var(--radius-pill); padding: var(--space-1) var(--space-4); cursor: pointer; }
.tab.on { background: var(--color-ink); border-color: var(--color-ink); color: var(--color-bg-soft); }
.layout { display: grid; grid-template-columns: minmax(0, 2fr) minmax(260px, 1fr); gap: var(--space-3); }
@media (max-width: 720px) { .layout { grid-template-columns: 1fr; } }
.card { background: var(--color-bg-soft); border-radius: var(--radius-m); padding: var(--space-3); min-width: 0; }
.units { list-style: none; margin: 0; padding: 0; }
.new { display: grid; gap: var(--space-2); margin-top: var(--space-3); border-top: 1px solid var(--color-bg-line); padding-top: var(--space-3); }
.row { display: flex; gap: var(--space-2); flex-wrap: wrap; align-items: center; }
.form { display: grid; gap: var(--space-2); }
.form label { display: grid; gap: var(--space-1); font-size: var(--font-size-body-s); color: var(--color-ink-muted); }
.check { display: flex !important; align-items: center; gap: var(--space-2); color: var(--color-ink) !important; }
input, select { font: inherit; border: 1px solid var(--color-bg-line); border-radius: var(--radius-s); padding: var(--space-1) var(--space-2); background: var(--color-bg); color: var(--color-ink); min-width: 0; box-sizing: border-box; }
input[type="checkbox"] { width: auto; }
.found { list-style: none; margin: 0; padding: 0; display: flex; gap: var(--space-1); flex-wrap: wrap; }
.btn { font: inherit; font-weight: 700; border: 1px solid var(--color-bg-line); background: var(--color-bg-soft); color: var(--color-ink); border-radius: var(--radius-pill); padding: var(--space-1) var(--space-4); cursor: pointer; }
.btn.primary { background: var(--color-sun); border-color: var(--color-sun); }
.btn.danger { background: var(--color-coral); border-color: var(--color-coral); color: var(--color-coral-deep); }
.btn.small { font-size: var(--font-size-body-s); padding: 0 var(--space-3); }
.btn:disabled { opacity: 0.5; }
.actions { display: flex; gap: var(--space-2); justify-content: flex-end; flex-wrap: wrap; }
.link { color: var(--color-teal-ink); font-weight: 700; text-decoration: none; }
.sub { color: var(--color-ink-faint); font-size: var(--font-size-body-s); }
.error { color: var(--color-coral-ink); }
.notice { color: var(--color-teal-ink); }
.table { width: 100%; border-collapse: collapse; margin-bottom: var(--space-3); }
th { text-align: left; font-size: var(--font-size-body-s); color: var(--color-ink-muted); padding: var(--space-1) var(--space-2); border-bottom: 1px solid var(--color-bg-line); }
td { padding: var(--space-1) var(--space-2); border-bottom: 1px solid var(--color-bg-line-soft); }
.chief-form { border-top: 1px solid var(--color-bg-line); padding-top: var(--space-3); }
</style>
