<script setup lang="ts">
definePageMeta({ layout: 'admin', middleware: 'admin-scope' })

const { t } = useI18n()
const { api, apiRaw } = useApi()
const { hasScope } = useAuth()
const route = useRoute()

interface PersonRow {
  id: string
  fullName: string
  phone: string | null
  status: string
  tags: string[]
  cityName: string | null
  lastSeenAt: string | null
  createdAt: string
  externalId: string | null
  isBlocked: boolean
  isHidden: boolean
  placements: { isPrimary: boolean, locationName: string, positionName: string, levelName: string | null, orgUnitName: string | null }[]
  roles: string[]
}
interface Ref { id: string, name: string }
interface Unit { id: string, name: string, children: Unit[], locations: Ref[] }

const tab = ref<'active' | 'blocked' | 'all'>('active')
const q = ref('')
const filter = reactive({ positionId: '', positionLevelId: '', cityId: '', orgUnitId: '', locationId: '', role: '', tag: '', registeredFrom: '', registeredTo: '', activeFrom: '', activeTo: '', includeHidden: false })
const showFilters = ref(false)
const items = ref<PersonRow[]>([])
const cursor = ref<string | null>(null)
const loading = ref(false)
const error = ref('')
const notice = ref('')
const refs = reactive<{ positions: Ref[], levels: Ref[], cities: Ref[], locations: Ref[], roles: { code: string, name: string }[], tags: Ref[], units: Unit[] }>({ positions: [], levels: [], cities: [], locations: [], roles: [], tags: [], units: [] })

// Колонки (docs/16 §5.1): выбор сохраняется в браузере
const ALL_COLUMNS = ['position', 'level', 'city', 'orgUnit', 'location', 'roles', 'tags', 'phone', 'status', 'registered', 'lastSeen', 'externalId'] as const
type Col = typeof ALL_COLUMNS[number]
const columns = ref<Col[]>(['position', 'location', 'roles', 'status', 'lastSeen'])
const showColumns = ref(false)
try { const saved = localStorage.getItem('lola.people.columns'); if (saved) columns.value = JSON.parse(saved) } catch { /* без сохранения */ }
watch(columns, (c) => { try { localStorage.setItem('lola.people.columns', JSON.stringify(c)) } catch { /* без сохранения */ } }, { deep: true })
function toggleColumn(c: Col) { columns.value = columns.value.includes(c) ? columns.value.filter(x => x !== c) : [...columns.value, c] }

const activeFilter = computed(() => Object.fromEntries(Object.entries(filter).filter(([, v]) => v !== '' && v !== false)))
const filterCount = computed(() => Object.keys(activeFilter.value).length)

async function load(reset = true) {
  loading.value = true
  error.value = ''
  try {
    const res = await apiRaw<{ data: PersonRow[], meta: { cursor: string | null } }>('/people', {
      query: { tab: tab.value, ...(q.value ? { q: q.value } : {}), ...activeFilter.value, ...(!reset && cursor.value ? { cursor: cursor.value } : {}) },
    })
    items.value = reset ? res.data : [...items.value, ...res.data]
    cursor.value = res.meta.cursor
    if (reset) selected.value = new Set()
  }
  catch (err) { error.value = apiErrorOf(err).message }
  finally { loading.value = false }
}

async function loadRefs() {
  try {
    const [positions, levels, cities, locations, roles, tags, tree] = await Promise.all([
      api<Ref[]>('/refs/positions'), api<Ref[]>('/refs/position-levels'), api<Ref[]>('/refs/cities'), api<Ref[]>('/refs/locations'),
      api<{ code: string, name: string }[]>('/settings/roles'), api<Ref[]>('/refs/tags'), api<{ units: Unit[] }>('/org/tree'),
    ])
    Object.assign(refs, { positions, levels, cities, locations, roles, tags, units: tree.units })
  }
  catch { /* фильтры останутся пустыми */ }
}

const flatUnits = computed(() => {
  const out: { id: string, name: string, depth: number }[] = []
  const walk = (u: Unit[], depth: number) => { for (const x of u) { out.push({ id: x.id, name: x.name, depth }); walk(x.children, depth + 1) } }
  walk(refs.units, 0)
  return out
})

function resetFilter() {
  Object.assign(filter, { positionId: '', positionLevelId: '', cityId: '', orgUnitId: '', locationId: '', role: '', tag: '', registeredFrom: '', registeredTo: '', activeFrom: '', activeTo: '', includeHidden: false })
  q.value = ''
}

watch(tab, () => load())
watch(filter, () => load())
let searchTimer: ReturnType<typeof setTimeout>
watch(q, () => { clearTimeout(searchTimer); searchTimer = setTimeout(() => load(), 300) })
onMounted(() => {
  if (route.query.orgUnitId) filter.orgUnitId = String(route.query.orgUnitId)
  load()
  loadRefs()
})

const exportUrl = computed(() => {
  const p = new URLSearchParams({ tab: tab.value, ...(q.value ? { q: q.value } : {}), ...Object.fromEntries(Object.entries(activeFilter.value).map(([k, v]) => [k, String(v)])) })
  return `/api/v1/people/export?${p}`
})

// ── Действия в строке ──
const menuFor = ref<string | null>(null)
async function act(fn: () => Promise<unknown>, done: string) {
  error.value = ''
  notice.value = ''
  menuFor.value = null
  try { await fn(); notice.value = done; await load() }
  catch (err) { error.value = apiErrorOf(err).message }
}
const closeSessions = (p: PersonRow) => act(() => api(`/people/${p.id}/sessions`, { method: 'DELETE' }), t('person.sessionsClosed'))
const block = (p: PersonRow) => act(() => api(`/people/${p.id}/${p.isBlocked ? 'unblock' : 'block'}`, { method: 'POST' }), t('common.saved'))
const resendCode = (p: PersonRow) => act(() => api(`/people/${p.id}/invite`, { method: 'POST' }), t('person.codeSent'))
const resetTelegram = (p: PersonRow) => act(() => api(`/people/${p.id}/reset-telegram`, { method: 'POST' }), t('person.telegramReset'))
const archiveOne = ref<PersonRow | null>(null)
const archiveForm = reactive({ reason: 'dismissal', comment: '', closeSessions: true, cancelLearning: true })
const archiveConfirm = () => act(async () => { await api(`/people/${archiveOne.value!.id}/archive`, { method: 'POST', body: { ...archiveForm } }); archiveOne.value = null }, t('common.saved'))

// ── Массовые действия ──
const selected = ref<Set<string>>(new Set())
const allChecked = computed(() => items.value.length > 0 && items.value.every(i => selected.value.has(i.id)))
function toggleAll() { selected.value = allChecked.value ? new Set() : new Set(items.value.map(i => i.id)) }
function toggle(id: string) { const s = new Set(selected.value); if (s.has(id)) s.delete(id); else s.add(id); selected.value = s }
const bulk = reactive({ action: '' as '' | 'add_tag' | 'set_location' | 'assign_role' | 'invite' | 'archive', tag: '', locationId: '', roleCode: '' })
async function runBulk() {
  if (!bulk.action) return
  if (bulk.action === 'archive' && !confirm(t('people.bulk.confirmArchive', { n: selected.value.size }))) return
  await act(async () => {
    const r = await api<{ done: number, errors: unknown[] }>('/people/bulk', { method: 'POST', body: { ids: [...selected.value], action: bulk.action, ...(bulk.tag ? { tag: bulk.tag } : {}), ...(bulk.locationId ? { locationId: bulk.locationId } : {}), ...(bulk.roleCode ? { roleCode: bulk.roleCode } : {}) } })
    notice.value = t('people.bulk.done', { done: r.done, errors: r.errors.length })
    bulk.action = ''
  }, notice.value)
}
function assignLearning() { navigateTo({ path: '/admin/assignments', query: { userIds: [...selected.value].join(',') } }) }

const primary = (p: PersonRow) => p.placements.find(x => x.isPrimary) ?? p.placements[0]
const fmtDate = (d: string | null) => d ? new Date(d).toLocaleDateString('uk') : '—'
</script>

<template>
  <div>
    <header class="head">
      <h1>{{ t('admin.nav.people') }}</h1>
      <div class="head-actions">
        <NuxtLink v-if="hasScope('people.invite')" to="/admin/people/new" class="btn primary">{{ t('people.add') }}</NuxtLink>
        <NuxtLink v-if="hasScope('people.import')" to="/admin/import" class="btn">{{ t('people.import') }}</NuxtLink>
        <a v-if="hasScope('report.export')" :href="exportUrl" class="btn" download>{{ t('people.export') }}</a>
      </div>
    </header>

    <div class="toolbar">
      <input v-model="q" class="search" type="search" :placeholder="t('people.search')" :aria-label="t('people.search')">
      <button class="btn" :aria-expanded="showFilters" @click="showFilters = !showFilters">{{ t('people.filters') }}<span v-if="filterCount" class="count">{{ filterCount }}</span></button>
      <button class="btn" :aria-expanded="showColumns" @click="showColumns = !showColumns">{{ t('people.columns') }}</button>
      <button v-if="filterCount || q" class="btn ghost" @click="resetFilter">{{ t('people.resetFilter') }}</button>
    </div>

    <section v-if="showFilters" class="filters card">
      <label>{{ t('people.col.position') }}<select v-model="filter.positionId"><option value="">{{ t('people.anyOption') }}</option><option v-for="r in refs.positions" :key="r.id" :value="r.id">{{ r.name }}</option></select></label>
      <label>{{ t('people.col.level') }}<select v-model="filter.positionLevelId"><option value="">{{ t('people.anyOption') }}</option><option v-for="r in refs.levels" :key="r.id" :value="r.id">{{ r.name }}</option></select></label>
      <label>{{ t('people.col.city') }}<select v-model="filter.cityId"><option value="">{{ t('people.anyOption') }}</option><option v-for="r in refs.cities" :key="r.id" :value="r.id">{{ r.name }}</option></select></label>
      <label>{{ t('people.orgFilter') }}<select v-model="filter.orgUnitId"><option value="">{{ t('people.anyOption') }}</option><option v-for="u in flatUnits" :key="u.id" :value="u.id">{{ '· '.repeat(u.depth) }}{{ u.name }}</option></select></label>
      <label>{{ t('people.col.location') }}<select v-model="filter.locationId"><option value="">{{ t('people.anyOption') }}</option><option v-for="r in refs.locations" :key="r.id" :value="r.id">{{ r.name }}</option></select></label>
      <label>{{ t('person.role') }}<select v-model="filter.role"><option value="">{{ t('people.anyOption') }}</option><option v-for="r in refs.roles" :key="r.code" :value="r.code">{{ r.name }}</option></select></label>
      <label>{{ t('people.col.tags') }}<select v-model="filter.tag"><option value="">{{ t('people.anyOption') }}</option><option v-for="r in refs.tags" :key="r.id" :value="r.name">{{ r.name }}</option></select></label>
      <label>{{ t('people.registeredFrom') }}<input v-model="filter.registeredFrom" type="date"></label>
      <label>{{ t('people.registeredTo') }}<input v-model="filter.registeredTo" type="date"></label>
      <label>{{ t('people.activeFrom') }}<input v-model="filter.activeFrom" type="date"></label>
      <label>{{ t('people.activeTo') }}<input v-model="filter.activeTo" type="date"></label>
      <label class="check"><input v-model="filter.includeHidden" type="checkbox"> {{ t('people.includeHidden') }}</label>
    </section>

    <section v-if="showColumns" class="columns card">
      <label v-for="c in ALL_COLUMNS" :key="c" class="check"><input type="checkbox" :checked="columns.includes(c)" @change="toggleColumn(c)"> {{ t(`people.col.${c}`) }}</label>
    </section>

    <div class="tabs" role="tablist">
      <button v-for="option in (['active', 'blocked', 'all'] as const)" :key="option" role="tab" :aria-selected="tab === option" :class="['tab', { on: tab === option }]" @click="tab = option">{{ t(`people.tab.${option}`) }}</button>
    </div>

    <p v-if="error" class="error">{{ error }}</p>
    <p v-if="notice" class="notice">{{ notice }}</p>

    <div v-if="selected.size" class="bulk card">
      <b>{{ t('people.bulk.selected', { n: selected.size }) }}</b>
      <select v-model="bulk.action" :aria-label="t('people.col.actions')">
        <option value="">{{ t('people.col.actions') }}</option>
        <option v-if="hasScope('people.edit')" value="add_tag">{{ t('people.bulk.addTag') }}</option>
        <option v-if="hasScope('people.edit')" value="set_location">{{ t('people.bulk.setLocation') }}</option>
        <option v-if="hasScope('role.assign')" value="assign_role">{{ t('people.bulk.assignRole') }}</option>
        <option v-if="hasScope('people.invite')" value="invite">{{ t('people.bulk.invite') }}</option>
        <option v-if="hasScope('people.deactivate')" value="archive">{{ t('people.bulk.archive') }}</option>
      </select>
      <input v-if="bulk.action === 'add_tag'" v-model="bulk.tag" list="tags-list" :placeholder="t('people.col.tags')">
      <datalist id="tags-list"><option v-for="r in refs.tags" :key="r.id" :value="r.name" /></datalist>
      <select v-if="bulk.action === 'set_location'" v-model="bulk.locationId"><option value="">{{ t('person.location') }}</option><option v-for="r in refs.locations" :key="r.id" :value="r.id">{{ r.name }}</option></select>
      <select v-if="bulk.action === 'assign_role'" v-model="bulk.roleCode"><option value="">{{ t('person.role') }}</option><option v-for="r in refs.roles" :key="r.code" :value="r.code">{{ r.name }}</option></select>
      <button class="btn primary" :disabled="!bulk.action" @click="runBulk">OK</button>
      <button v-if="hasScope('assignment.create')" class="btn" @click="assignLearning">{{ t('people.bulk.assignLearning') }}</button>
    </div>

    <div v-if="loading && items.length === 0" class="empty">{{ t('common.loading') }}</div>
    <div v-else-if="items.length === 0" class="empty">{{ t('people.empty') }}</div>

    <div v-else class="table-wrap">
      <table class="table">
        <thead>
          <tr>
            <th class="chk"><input type="checkbox" :checked="allChecked" :aria-label="t('people.bulk.selected', { n: items.length })" @change="toggleAll"></th>
            <th>{{ t('people.col.name') }}</th>
            <th v-for="c in columns" :key="c">{{ t(`people.col.${c}`) }}</th>
            <th class="act">{{ t('people.col.actions') }}</th>
          </tr>
        </thead>
        <tbody>
          <tr v-for="person in items" :key="person.id" class="row">
            <td class="chk"><input type="checkbox" :checked="selected.has(person.id)" :aria-label="person.fullName" @change="toggle(person.id)"></td>
            <td>
              <NuxtLink :to="`/admin/people/${person.id}`" class="name">{{ person.fullName }}</NuxtLink>
              <span v-if="person.isHidden" class="mini">{{ t('people.hiddenBadge') }}</span>
              <span v-if="person.isBlocked" class="mini coral">{{ t('people.blockedBadge') }}</span>
              <div v-if="!columns.includes('phone')" class="sub">{{ person.phone }}</div>
            </td>
            <template v-for="c in columns" :key="c">
              <td v-if="c === 'position'">{{ primary(person)?.positionName || '—' }}</td>
              <td v-else-if="c === 'level'">{{ primary(person)?.levelName || '—' }}</td>
              <td v-else-if="c === 'city'">{{ person.cityName || '—' }}</td>
              <td v-else-if="c === 'orgUnit'">{{ primary(person)?.orgUnitName || '—' }}</td>
              <td v-else-if="c === 'location'">{{ primary(person)?.locationName || '—' }}</td>
              <td v-else-if="c === 'roles'">{{ person.roles.join(', ') || '—' }}</td>
              <td v-else-if="c === 'tags'">{{ person.tags.join(', ') || '—' }}</td>
              <td v-else-if="c === 'phone'">{{ person.phone || '—' }}</td>
              <td v-else-if="c === 'status'"><span :class="['badge', person.status]">{{ t(`people.status.${person.status}`) }}</span></td>
              <td v-else-if="c === 'registered'" class="sub">{{ fmtDate(person.createdAt) }}</td>
              <td v-else-if="c === 'lastSeen'" class="sub">{{ fmtDate(person.lastSeenAt) }}</td>
              <td v-else-if="c === 'externalId'" class="sub">{{ person.externalId || '—' }}</td>
            </template>
            <td class="act">
              <button class="dots" :aria-label="t('people.col.actions')" :aria-expanded="menuFor === person.id" @click="menuFor = menuFor === person.id ? null : person.id">⋯</button>
              <div v-if="menuFor === person.id" class="menu" role="menu">
                <NuxtLink :to="`/admin/people/${person.id}`" role="menuitem">{{ t('people.row.details') }}</NuxtLink>
                <NuxtLink v-if="hasScope('people.edit')" :to="`/admin/people/${person.id}?tab=profile&edit=1`" role="menuitem">{{ t('people.row.edit') }}</NuxtLink>
                <NuxtLink :to="`/admin/people/${person.id}?tab=roles`" role="menuitem">{{ t('people.row.roles') }}</NuxtLink>
                <button v-if="hasScope('people.edit')" role="menuitem" @click="closeSessions(person)">{{ t('people.row.closeSessions') }}</button>
                <button v-if="hasScope('people.invite')" role="menuitem" @click="resendCode(person)">{{ t('people.row.resendCode') }}</button>
                <button v-if="hasScope('people.edit')" role="menuitem" @click="resetTelegram(person)">{{ t('people.row.resetTelegram') }}</button>
                <button v-if="hasScope('people.deactivate') && person.status !== 'archived'" role="menuitem" @click="block(person)">{{ person.isBlocked ? t('people.row.unblock') : t('people.row.block') }}</button>
                <button v-if="hasScope('people.deactivate') && person.status !== 'archived'" role="menuitem" class="danger" @click="archiveOne = person; menuFor = null">{{ t('people.row.archive') }}</button>
              </div>
            </td>
          </tr>
        </tbody>
      </table>
    </div>

    <button v-if="cursor" class="btn more" :disabled="loading" @click="load(false)">{{ t('common.loadMore') }}</button>

    <div v-if="archiveOne" class="overlay" @click.self="archiveOne = null">
      <form class="modal" role="dialog" aria-modal="true" @submit.prevent="archiveConfirm">
        <h2>{{ t('person.archiveTitle') }}: {{ archiveOne.fullName }}</h2>
        <label>{{ t('person.archiveReason') }}<select v-model="archiveForm.reason"><option v-for="r in ['dismissal', 'transfer', 'mistake', 'other']" :key="r" :value="r">{{ t(`person.reasons.${r}`) }}</option></select></label>
        <label>{{ t('person.comment') }}<input v-model="archiveForm.comment" maxlength="500"></label>
        <label class="check"><input v-model="archiveForm.closeSessions" type="checkbox"> {{ t('person.archiveClose') }}</label>
        <label class="check"><input v-model="archiveForm.cancelLearning" type="checkbox"> {{ t('person.archiveCancel') }}</label>
        <div class="modal-actions">
          <button type="button" class="btn" @click="archiveOne = null">{{ t('common.cancel') }}</button>
          <button type="submit" class="btn danger">{{ t('person.archive') }}</button>
        </div>
      </form>
    </div>
  </div>
</template>

<style scoped>
.head { display: flex; align-items: center; gap: var(--space-3); margin-bottom: var(--space-3); flex-wrap: wrap; }
.head-actions { display: flex; gap: var(--space-2); flex-wrap: wrap; margin-left: auto; }
h1 { margin: 0; font-weight: 900; }
h2 { margin: 0 0 var(--space-2); font-size: var(--font-size-body); font-weight: 800; }
.toolbar { display: flex; gap: var(--space-2); align-items: center; flex-wrap: wrap; margin-bottom: var(--space-3); }
.search { font: inherit; border: 1px solid var(--color-bg-line); border-radius: var(--radius-pill); padding: var(--space-2) var(--space-4); background: var(--color-bg-soft); color: var(--color-ink); min-width: 200px; flex: 1; max-width: 360px; }
.btn { font: inherit; font-weight: 700; border: 1px solid var(--color-bg-line); background: var(--color-bg-soft); color: var(--color-ink); border-radius: var(--radius-pill); padding: var(--space-2) var(--space-4); cursor: pointer; text-decoration: none; display: inline-flex; align-items: center; gap: var(--space-1); }
.btn.primary { background: var(--color-sun); border-color: var(--color-sun); }
.btn.danger { background: var(--color-coral); border-color: var(--color-coral); color: var(--color-coral-deep); }
.btn.ghost { border-color: transparent; background: transparent; color: var(--color-ink-muted); }
.btn:disabled { opacity: 0.5; }
.count { background: var(--color-ink); color: var(--color-bg-soft); border-radius: var(--radius-pill); font-size: var(--font-size-body-s); padding: 0 var(--space-2); }
.card { background: var(--color-bg-soft); border-radius: var(--radius-m); padding: var(--space-3); margin-bottom: var(--space-3); }
.filters { display: grid; grid-template-columns: repeat(auto-fill, minmax(180px, 1fr)); gap: var(--space-2) var(--space-3); }
.filters label, .modal label { display: grid; gap: var(--space-1); font-size: var(--font-size-body-s); color: var(--color-ink-muted); }
.columns { display: flex; flex-wrap: wrap; gap: var(--space-2) var(--space-4); }
.check { display: flex !important; align-items: center; gap: var(--space-2); color: var(--color-ink); }
select, input[type="date"], input[type="text"], input:not([type]) { font: inherit; border: 1px solid var(--color-bg-line); border-radius: var(--radius-s); padding: var(--space-1) var(--space-2); background: var(--color-bg); color: var(--color-ink); min-width: 0; }
.tabs { display: flex; gap: var(--space-2); margin-bottom: var(--space-3); flex-wrap: wrap; }
.tab { font: inherit; font-weight: 700; border: 1px solid var(--color-bg-line); background: transparent; color: var(--color-ink-muted); border-radius: var(--radius-pill); padding: var(--space-1) var(--space-4); cursor: pointer; }
.tab.on { background: var(--color-ink); border-color: var(--color-ink); color: var(--color-bg-soft); }
.bulk { display: flex; gap: var(--space-2); align-items: center; flex-wrap: wrap; border: 1px solid var(--color-sun); }
.table-wrap { overflow-x: auto; }
.table { width: 100%; border-collapse: collapse; background: var(--color-bg-soft); border-radius: var(--radius-m); overflow: hidden; }
th { text-align: left; font-size: var(--font-size-body-s); color: var(--color-ink-muted); padding: var(--space-2) var(--space-3); border-bottom: 1px solid var(--color-bg-line); white-space: nowrap; }
td { padding: var(--space-2) var(--space-3); border-bottom: 1px solid var(--color-bg-line-soft); vertical-align: top; }
.chk { width: 32px; }
.act { position: relative; width: 48px; }
.row:hover { background: var(--color-bg); }
.name { font-weight: 700; color: var(--color-ink); text-decoration: none; }
.mini { font-size: var(--font-size-body-s); color: var(--color-ink-faint); margin-left: var(--space-2); }
.mini.coral { color: var(--color-coral-ink); }
.sub { font-size: var(--font-size-body-s); color: var(--color-ink-faint); }
.badge { font-size: var(--font-size-body-s); font-weight: 700; border-radius: var(--radius-pill); padding: 2px var(--space-3); background: var(--color-bg-line-soft); white-space: nowrap; }
.badge.active { background: var(--color-teal); color: var(--color-teal-deep); }
.badge.invited { background: var(--color-sun); color: var(--color-sun-ink); }
.badge.suspended, .badge.archived { background: var(--color-coral); color: var(--color-coral-deep); }
.dots { font: inherit; font-weight: 900; border: none; background: transparent; cursor: pointer; padding: 0 var(--space-2); color: var(--color-ink); }
.menu { position: absolute; right: var(--space-2); top: 100%; z-index: 5; background: var(--color-bg-soft); border: 1px solid var(--color-bg-line); border-radius: var(--radius-m); display: grid; min-width: 220px; box-shadow: 0 8px 24px rgb(0 0 0 / 12%); }
.menu > * { font: inherit; text-align: left; border: none; background: transparent; padding: var(--space-2) var(--space-3); color: var(--color-ink); text-decoration: none; cursor: pointer; }
.menu > *:hover { background: var(--color-bg); }
.menu .danger { color: var(--color-coral-ink); }
.empty { padding: var(--space-7); text-align: center; color: var(--color-ink-faint); }
.error { color: var(--color-coral-ink); }
.notice { color: var(--color-teal-ink); }
.more { margin-top: var(--space-3); }
.overlay { position: fixed; inset: 0; background: rgb(0 0 0 / 40%); display: grid; place-items: center; padding: var(--space-3); z-index: 20; }
.modal { background: var(--color-bg-soft); border-radius: var(--radius-l); padding: var(--space-4); display: grid; gap: var(--space-3); width: min(440px, 100%); box-sizing: border-box; }
.modal-actions { display: flex; gap: var(--space-2); justify-content: flex-end; flex-wrap: wrap; }
</style>
