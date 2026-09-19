<script setup lang="ts">
definePageMeta({ layout: 'admin', middleware: 'admin-scope', requiredScope: 'people.view' })
const { t } = useI18n()
const { api, apiRaw } = useApi()
const { hasScope } = useAuth()

interface Group { id: string, name: string, kind: 'static' | 'dynamic', members: string[], filter: Record<string, unknown> | null, isActive: boolean, recalcAt: string | null, size: number }
interface Ref { id: string, name: string }
const groups = ref<Group[]>([])
const error = ref('')
const notice = ref('')
const busy = ref(false)
const editing = ref<Group | null>(null)
const refs = reactive<{ positions: Ref[], locations: Ref[], levels: Ref[] }>({ positions: [], locations: [], levels: [] })

const form = reactive({ id: '', name: '', kind: 'static' as 'static' | 'dynamic', isActive: true, members: [] as { id: string, fullName: string }[], filter: { positionIds: [] as string[], locationIds: [] as string[], positionLevelIds: [] as string[], hiredFrom: '', hiredTo: '', certificateExpiringDays: '' } })
const search = ref('')
const found = ref<{ id: string, fullName: string }[]>([])

async function load() {
  try { groups.value = await api('/user-groups') }
  catch (err) { error.value = apiErrorOf(err).message }
}
onMounted(async () => {
  load()
  try {
    const [positions, locations, levels] = await Promise.all([api<Ref[]>('/refs/positions'), api<Ref[]>('/refs/locations'), api<Ref[]>('/refs/position-levels')])
    Object.assign(refs, { positions, locations, levels })
  }
  catch { /* фильтры пустые */ }
})

function openNew() {
  editing.value = { id: '', name: '', kind: 'static', members: [], filter: null, isActive: true, recalcAt: null, size: 0 }
  Object.assign(form, { id: '', name: '', kind: 'static', isActive: true, members: [], filter: { positionIds: [], locationIds: [], positionLevelIds: [], hiredFrom: '', hiredTo: '', certificateExpiringDays: '' } })
}
async function openEdit(g: Group) {
  editing.value = g
  const f = (g.filter ?? {}) as Record<string, unknown>
  Object.assign(form, { id: g.id, name: g.name, kind: g.kind, isActive: g.isActive, members: [], filter: { positionIds: (f.positionIds as string[]) ?? [], locationIds: (f.locationIds as string[]) ?? [], positionLevelIds: (f.positionLevelIds as string[]) ?? [], hiredFrom: String(f.hiredFrom ?? ''), hiredTo: String(f.hiredTo ?? ''), certificateExpiringDays: f.certificateExpiringDays ? String(f.certificateExpiringDays) : '' } })
  if (g.kind === 'static' && g.members.length) {
    // Имена участников — из списка людей (первые 100)
    try {
      const res = await apiRaw<{ data: { id: string, fullName: string }[] }>('/people', { query: { tab: 'all', limit: 100, includeHidden: true } })
      const byId = new Map(res.data.map(p => [p.id, p.fullName]))
      form.members = g.members.map(id => ({ id, fullName: byId.get(id) ?? id.slice(0, 8) }))
    }
    catch { form.members = g.members.map(id => ({ id, fullName: id.slice(0, 8) })) }
  }
}
let timer: ReturnType<typeof setTimeout>
watch(search, (v) => {
  clearTimeout(timer)
  if (!v.trim()) { found.value = []; return }
  timer = setTimeout(async () => {
    try { found.value = (await apiRaw<{ data: { id: string, fullName: string }[] }>('/people', { query: { q: v, tab: 'active', limit: 10 } })).data.filter(p => !form.members.some(m => m.id === p.id)) }
    catch { found.value = [] }
  }, 300)
})
function addMember(p: { id: string, fullName: string }) { form.members.push(p); found.value = found.value.filter(f => f.id !== p.id); search.value = '' }

async function save() {
  busy.value = true
  error.value = ''
  try {
    const f = form.filter
    const filter = form.kind === 'dynamic'
      ? { ...(f.positionIds.length ? { positionIds: f.positionIds } : {}), ...(f.locationIds.length ? { locationIds: f.locationIds } : {}), ...(f.positionLevelIds.length ? { positionLevelIds: f.positionLevelIds } : {}), ...(f.hiredFrom ? { hiredFrom: f.hiredFrom } : {}), ...(f.hiredTo ? { hiredTo: f.hiredTo } : {}), ...(f.certificateExpiringDays ? { certificateExpiringDays: Number(f.certificateExpiringDays) } : {}) }
      : null
    await api('/user-groups', { method: 'PUT', body: { ...(form.id ? { id: form.id } : {}), name: form.name, kind: form.kind, isActive: form.isActive, members: form.kind === 'static' ? form.members.map(m => m.id) : [], filter } })
    editing.value = null
    notice.value = t('common.saved')
    await load()
  }
  catch (err) { error.value = apiErrorOf(err).message }
  finally { busy.value = false }
}
async function remove(g: Group) {
  if (!confirm(t('groups.confirmDelete', { name: g.name }))) return
  try { await api(`/user-groups/${g.id}`, { method: 'DELETE' }); await load() }
  catch (err) { error.value = apiErrorOf(err).message }
}
const fmt = (d: string | null) => d ? new Date(d).toLocaleString('uk') : '—'
</script>

<template>
  <div>
    <header class="head">
      <h1>{{ t('groups.title') }}</h1>
      <button v-if="hasScope('people.edit')" class="btn primary" @click="openNew">{{ t('groups.new') }}</button>
    </header>
    <p v-if="error" class="error" role="alert">{{ error }}</p>
    <p v-if="notice" class="notice" role="status">{{ notice }}</p>

    <div v-if="groups.length === 0" class="empty">{{ t('groups.empty') }}</div>
    <ul v-else class="list">
      <li v-for="g in groups" :key="g.id" class="card row">
        <div class="grow">
          <b>{{ g.name }}</b> <span class="badge">{{ t(`groups.${g.kind}`) }}</span> <span v-if="!g.isActive" class="sub">· {{ t('common.deactivate') }}</span>
          <div class="sub">{{ t('groups.size', { n: g.size }) }}<template v-if="g.kind === 'dynamic'"> · {{ t('groups.recalc', { at: fmt(g.recalcAt) }) }}</template></div>
        </div>
        <button v-if="hasScope('people.edit')" class="btn" @click="openEdit(g)">{{ t('common.edit') }}</button>
        <button v-if="hasScope('people.edit')" class="btn danger" @click="remove(g)">{{ t('groups.delete') }}</button>
      </li>
    </ul>

    <div v-if="editing" class="overlay" @click.self="editing = null">
      <form class="modal" role="dialog" aria-modal="true" @submit.prevent="save">
        <h2>{{ form.id ? t('common.edit') : t('groups.new') }}</h2>
        <label>{{ t('groups.name') }}<input v-model="form.name" required maxlength="120"></label>
        <label>{{ t('groups.kind') }}<select v-model="form.kind"><option value="static">{{ t('groups.static') }}</option><option value="dynamic">{{ t('groups.dynamic') }}</option></select></label>
        <label class="check"><input v-model="form.isActive" type="checkbox"> {{ t('groups.active') }}</label>

        <template v-if="form.kind === 'static'">
          <label>{{ t('groups.members') }}<input v-model="search" type="search" :placeholder="t('groups.membersHint')"></label>
          <ul v-if="found.length" class="found">
            <li v-for="p in found" :key="p.id"><button type="button" class="btn small" @click="addMember(p)">+ {{ p.fullName }}</button></li>
          </ul>
          <ul class="chips">
            <li v-for="m in form.members" :key="m.id" class="chip">{{ m.fullName }} <button type="button" :aria-label="t('common.cancel')" @click="form.members = form.members.filter(x => x.id !== m.id)">×</button></li>
          </ul>
        </template>
        <template v-else>
          <label>{{ t('groups.positions') }}<select v-model="form.filter.positionIds" multiple size="4"><option v-for="r in refs.positions" :key="r.id" :value="r.id">{{ r.name }}</option></select></label>
          <label>{{ t('groups.locations') }}<select v-model="form.filter.locationIds" multiple size="4"><option v-for="r in refs.locations" :key="r.id" :value="r.id">{{ r.name }}</option></select></label>
          <label>{{ t('groups.levels') }}<select v-model="form.filter.positionLevelIds" multiple size="3"><option v-for="r in refs.levels" :key="r.id" :value="r.id">{{ r.name }}</option></select></label>
          <div class="two">
            <label>{{ t('groups.hiredFrom') }}<input v-model="form.filter.hiredFrom" type="date"></label>
            <label>{{ t('groups.hiredTo') }}<input v-model="form.filter.hiredTo" type="date"></label>
          </div>
          <label>{{ t('groups.certExpiring') }}<input v-model="form.filter.certificateExpiringDays" type="number" min="1" max="365"></label>
        </template>

        <div class="modal-actions">
          <button type="button" class="btn" @click="editing = null">{{ t('common.cancel') }}</button>
          <button type="submit" class="btn primary" :disabled="busy || !form.name">{{ t('common.save') }}</button>
        </div>
      </form>
    </div>
  </div>
</template>

<style scoped>
.head { display: flex; align-items: center; gap: var(--space-3); margin-bottom: var(--space-3); flex-wrap: wrap; }
h1 { margin: 0; font-weight: 900; }
h2 { margin: 0; font-weight: 800; }
.list { list-style: none; margin: 0; padding: 0; display: grid; gap: var(--space-2); }
.card { background: var(--color-bg-soft); border-radius: var(--radius-m); padding: var(--space-3); }
.row { display: flex; gap: var(--space-2); align-items: center; flex-wrap: wrap; }
.grow { flex: 1; min-width: 160px; }
.sub { color: var(--color-ink-faint); font-size: var(--font-size-body-s); }
.badge { font-size: var(--font-size-body-s); font-weight: 700; border-radius: var(--radius-pill); padding: 2px var(--space-3); background: var(--color-bg-line-soft); }
.btn { font: inherit; font-weight: 700; border: 1px solid var(--color-bg-line); background: var(--color-bg-soft); color: var(--color-ink); border-radius: var(--radius-pill); padding: var(--space-1) var(--space-4); cursor: pointer; }
.btn.primary { background: var(--color-sun); border-color: var(--color-sun); }
.btn.danger { background: var(--color-coral); border-color: var(--color-coral); color: var(--color-coral-deep); }
.btn.small { font-size: var(--font-size-body-s); padding: 0 var(--space-3); }
.btn:disabled { opacity: 0.5; }
.empty { padding: var(--space-7); text-align: center; color: var(--color-ink-faint); }
.error { color: var(--color-coral-ink); }
.notice { color: var(--color-teal-ink); }
.overlay { position: fixed; inset: 0; background: rgb(0 0 0 / 40%); display: grid; place-items: center; padding: var(--space-3); z-index: 20; overflow: auto; }
.modal { background: var(--color-bg-soft); border-radius: var(--radius-l); padding: var(--space-4); display: grid; gap: var(--space-3); width: min(480px, 100%); box-sizing: border-box; max-height: 100%; overflow: auto; }
.modal label { display: grid; gap: var(--space-1); font-size: var(--font-size-body-s); color: var(--color-ink-muted); }
.modal .check { display: flex; align-items: center; gap: var(--space-2); color: var(--color-ink); }
.two { display: grid; grid-template-columns: 1fr 1fr; gap: var(--space-2); }
input, select { font: inherit; border: 1px solid var(--color-bg-line); border-radius: var(--radius-s); padding: var(--space-1) var(--space-2); background: var(--color-bg); color: var(--color-ink); min-width: 0; width: 100%; box-sizing: border-box; }
input[type="checkbox"] { width: auto; }
.found { list-style: none; margin: 0; padding: 0; display: flex; gap: var(--space-1); flex-wrap: wrap; }
.chips { list-style: none; margin: 0; padding: 0; display: flex; gap: var(--space-1); flex-wrap: wrap; }
.chip { background: var(--color-bg-line-soft); border-radius: var(--radius-pill); padding: 2px var(--space-3); font-size: var(--font-size-body-s); }
.chip button { border: none; background: transparent; cursor: pointer; font: inherit; font-weight: 900; }
.modal-actions { display: flex; gap: var(--space-2); justify-content: flex-end; flex-wrap: wrap; }
</style>
