<script setup lang="ts">
/**
 * `/org-structure` — дерево подчинения (docs/v2/32-org-structure.md §5, §6).
 *
 * Два таба одного дерева: «Співробітник — перегляд» видят все роли (`org.structure.view`),
 * «Адмін — конструктор» — только `org.structure.edit`. У рядового сотрудника таб
 * конструктора **не отрисован вовсе**, и иконок управления на карточках нет (критерий
 * приёмки 8) — это не «кнопка, которая ничего не делает», а отсутствие кнопки.
 *
 * Руководителю доступна своя ветка: сервер возвращает её пути в `branches`, drop за её
 * пределы блокируется с подсказкой «Ви можете змінювати лише свою гілку». Право всё равно
 * проверяется на сервере (`canEditNode()`); здесь — чтобы человек не тащил карточку впустую.
 *
 * PR-31 достраивает конструктор до `32` §5.1 и §6: панель «Імпорт», «Експорт CSV», «Знімок»,
 * «Знімки» с откатом; форма узла целиком (посада, філія, підрозділ, батьківський вузол —
 * клавиатурный путь для перетаскивания); диалоги привязки человека и подтверждения переноса.
 */
import { descendantsOf } from '#shared/domain/orgLayout'

definePageMeta({ layout: 'learner' })

const { t } = useI18n()
const { api } = useApi()
const { hasScope, me } = useAuth()
const { formatDateTime } = useFormat()

interface Holder { assignmentId?: string, userId: string, fullName: string, email: string | null, roleInNode: string, isPrimary: boolean }
interface Node {
  id: string
  parentId: string | null
  depth: number
  type: 'position' | 'employee'
  title: string
  note?: string | null
  positionId: string | null
  positionName: string | null
  locationId: string | null
  locationName: string | null
  orgUnitId: string | null
  orgUnitName: string | null
  headcountPlanned: number
  headcountActual: number
  isManagerPoint: boolean
  state: 'vacant' | 'occupied' | 'archived'
  holders: Holder[]
  children: Node[]
}
interface Tree { nodes: Node[], total: number, mode: 'admin' | 'view', canEditAll: boolean, branches: string[] }
interface Ref { id: string, name: string, isActive?: boolean }

/** Подпись роли держателя — ключи словаря, а не склейка строки из кода роли. */
const ROLE_LABEL: Record<string, string> = { holder: 'orgStructure.roleHolder', acting: 'orgStructure.roleActing', deputy: 'orgStructure.roleDeputy' }

const canEdit = computed(() => hasScope('org.structure.edit'))
const canImport = computed(() => hasScope('org.structure.import'))
const tab = ref<'view' | 'admin'>('view')
const tree = ref<Tree | null>(null)
const loading = ref(true)
const loadFailed = ref(false)
const error = ref('')
const notice = ref('')
const busy = ref(false)
const collapsed = ref<Record<string, boolean>>({})
const editableIds = ref<Set<string>>(new Set())

/** Узел, который человек тащит. Пустая строка — перетаскивания нет. */
const dragging = ref('')
const dropTarget = ref('')

const form = reactive({
  open: false,
  id: '',
  parentId: null as string | null,
  originalParentId: null as string | null,
  type: 'position' as 'position' | 'employee',
  positionId: '',
  title: '',
  headcountPlanned: 1,
  isManagerPoint: false,
  locationId: '',
  orgUnitId: '',
  note: '',
})
const refs = reactive({ loaded: false, positions: [] as Ref[], locations: [] as Ref[], units: [] as Ref[] })

const assignFor = ref<Node | null>(null)
const moveReq = ref<{ node: Node, target: Node | null, descendants: number } | null>(null)
const importOpen = ref(false)
const snapshotsOpen = ref(false)

/**
 * Поиск и фильтры (`32` §5.1): по ФИО и названию узла, «Філія», «Підрозділ», «Посада»,
 * «Показати вакансії». Считаются по уже загруженному дереву: подходящий узел виден вместе с
 * цепочкой до корня, иначе было бы непонятно, где он стоит. Варианты фильтров — из самого
 * дерева, поэтому витрина работает и у того, кому справочники не открыты.
 */
const filters = reactive({ q: '', locationId: '', orgUnitId: '', positionId: '', showVacant: true })
const filtering = computed(() => !!(filters.q.trim() || filters.locationId || filters.orgUnitId || filters.positionId || !filters.showVacant))

function optionsOf(key: 'location' | 'orgUnit' | 'position'): { id: string, name: string }[] {
  const seen = new Map<string, string>()
  for (const n of flat.value) {
    const id = n[`${key}Id`]
    const name = n[`${key}Name`]
    if (id && name) seen.set(id, name)
  }
  return [...seen].map(([id, name]) => ({ id, name })).sort((a, b) => a.name.localeCompare(b.name))
}

function matches(n: Node): boolean {
  const q = filters.q.trim().toLowerCase()
  if (q && !n.title.toLowerCase().includes(q) && !n.holders.some(h => h.fullName.toLowerCase().includes(q))) return false
  if (filters.locationId && n.locationId !== filters.locationId) return false
  if (filters.orgUnitId && n.orgUnitId !== filters.orgUnitId) return false
  if (filters.positionId && n.positionId !== filters.positionId) return false
  return true
}

/** Дерево после фильтров: узел остаётся, если подходит сам или подходит кто-то под ним. */
const shownNodes = computed<Node[]>(() => {
  if (!filtering.value) return tree.value?.nodes ?? []
  const prune = (nodes: Node[]): Node[] => nodes.flatMap((n) => {
    const children = prune(n.children)
    if (!filters.showVacant && n.state === 'vacant' && !children.length) return []
    const fit = (filters.q.trim() || filters.locationId || filters.orgUnitId || filters.positionId) ? matches(n) : true
    return fit || children.length ? [{ ...n, children }] : []
  })
  return prune(tree.value?.nodes ?? [])
})

function resetFilters() {
  Object.assign(filters, { q: '', locationId: '', orgUnitId: '', positionId: '', showVacant: true })
}

/** Все узлы плоским списком, в порядке дерева, — для пикеров и подписей. */
const flat = computed(() => {
  const out: Node[] = []
  const walk = (nodes: Node[]) => { for (const n of nodes) { out.push(n); walk(n.children) } }
  walk(tree.value?.nodes ?? [])
  return out
})
const byId = computed(() => new Map(flat.value.map(n => [n.id, n])))
const titleOf = (id: string) => byId.value.get(id)?.title ?? ''
const editedNode = computed(() => (form.id ? byId.value.get(form.id) ?? null : null))

/** Куда можно подчинить узел: своя ветка (или всё дерево), кроме самого узла и его потомков. */
const parentChoices = computed(() => {
  const banned = new Set(form.id ? [form.id, ...descendantsOf(flat.value, form.id)] : [])
  return flat.value.filter(n => !banned.has(n.id) && canEditNodeId(n.id))
})

async function load() {
  error.value = ''
  loadFailed.value = false
  loading.value = true
  try {
    const mode = tab.value === 'admin' && canEdit.value ? 'admin' : 'view'
    const data = await api<Tree>('/org-structure/tree', { query: { mode } })
    tree.value = data
    // Права на конкретный узел: либо весь тенант, либо поддеревья, где человек держатель.
    if (data.canEditAll) editableIds.value = new Set(allIds(data.nodes))
    else editableIds.value = branchIds(data.nodes, data.branches)
  }
  // «Не вдалося завантажити структуру» + «Спробувати ще раз», дерево на экране остаётся (`32` §5.1).
  catch { loadFailed.value = true }
  finally { loading.value = false }
}

function allIds(nodes: Node[], out: string[] = []): string[] {
  for (const n of nodes) { out.push(n.id); allIds(n.children, out) }
  return out
}

/** Узлы, где человек держатель, и всё под ними — «своя ветка» (`32` §2). */
function branchIds(nodes: Node[], branches: string[], inside = false, out = new Set<string>()): Set<string> {
  const myId = me.value?.user.id
  for (const n of nodes) {
    const mine = inside || (branches.length > 0 && n.holders.some(h => h.userId === myId))
    if (mine) out.add(n.id)
    branchIds(n.children, branches, mine, out)
  }
  return out
}

function canEditNodeId(id: string): boolean {
  return tab.value === 'admin' && canEdit.value && (tree.value?.canEditAll === true || editableIds.value.has(id))
}

/** Справочники формы узла (`32` §6.1) — один раз, при первом открытии формы. */
async function loadRefs() {
  if (refs.loaded) return
  refs.loaded = true
  const [positions, locations, units] = await Promise.all([
    api<Ref[]>('/refs/positions').catch(() => []),
    api<Ref[]>('/refs/locations').catch(() => []),
    api<Ref[]>('/refs/org-units').catch(() => []),
  ])
  refs.positions = positions.filter(p => p.isActive !== false)
  refs.locations = locations.filter(l => l.isActive !== false)
  refs.units = units
}

function openCreate(parentId: string | null) {
  Object.assign(form, { open: true, id: '', parentId, originalParentId: parentId, type: 'position', positionId: '', title: '', headcountPlanned: 1, isManagerPoint: false, locationId: '', orgUnitId: '', note: '' })
  loadRefs()
}

function openEdit(n: Node) {
  Object.assign(form, {
    open: true,
    id: n.id,
    parentId: n.parentId,
    originalParentId: n.parentId,
    type: n.type,
    positionId: n.positionId ?? '',
    title: n.title,
    headcountPlanned: n.headcountPlanned,
    isManagerPoint: n.isManagerPoint,
    locationId: n.locationId ?? '',
    orgUnitId: n.orgUnitId ?? '',
    note: n.note ?? '',
  })
  loadRefs()
}

function fail(err: unknown) {
  const e = apiErrorOf(err)
  const key = `orgStructure.err.${e.code}`
  const text = t(key)
  error.value = text === key ? e.message : text
}

async function save() {
  error.value = ''
  if (!form.title.trim() && !form.positionId) {
    error.value = t('orgStructure.titleOrPosition')
    return
  }
  busy.value = true
  try {
    const body = {
      type: form.type,
      title: form.title.trim() || undefined,
      positionId: form.positionId || null,
      orgUnitId: form.orgUnitId || null,
      locationId: form.locationId || null,
      headcountPlanned: form.type === 'employee' ? 1 : form.headcountPlanned,
      isManagerPoint: form.isManagerPoint,
      note: form.note || null,
    }
    if (form.id) {
      await api(`/org-structure/nodes/${form.id}`, { method: 'PUT', body })
      const node = editedNode.value
      const moved = form.parentId !== form.originalParentId
      form.open = false
      notice.value = t('orgStructure.nodeSaved')
      await load()
      // Смена родителя в форме — то же перемещение, что и перетаскивание: с подтверждением.
      if (moved && node) askMove(node, form.parentId)
    }
    else {
      const created = await api<Node>('/org-structure/nodes', { method: 'POST', body: { ...body, parentId: form.parentId } })
      form.open = false
      notice.value = t('orgStructure.nodeCreated')
      await load()
      // Именной узел без человека пуст: сразу — привязка (`32` §6.1 «Співробітник»).
      const fresh = byId.value.get(created.id)
      if (form.type === 'employee' && fresh) assignFor.value = fresh
    }
  }
  catch (err) { fail(err) }
  finally { busy.value = false }
}

async function archive(id: string) {
  busy.value = true
  error.value = ''
  try { await api(`/org-structure/nodes/${id}/archive`, { method: 'POST' }); await load() }
  catch (err) { fail(err) }
  finally { busy.value = false }
}

async function unassign(assignmentId: string) {
  busy.value = true
  error.value = ''
  try {
    await api(`/org-structure/assignments/${assignmentId}`, { method: 'DELETE', body: { endedReason: 'manual' } })
    notice.value = t('orgStructure.unassigned')
    await load()
  }
  catch (err) { fail(err) }
  finally { busy.value = false }
}

async function snapshot() {
  busy.value = true
  error.value = ''
  try {
    // Подпись снимка — его имя для человека: её покажут список снимков и письмо об откате
    // (`32` §8 `org_structure_rollback`), в журнале она лежит в `audit_log.after`. Поэтому это
    // местное время в языке интерфейса (`useFormat()`), а не UTC-строка `toISOString()`,
    // которая для Киева отставала на два-три часа.
    await api('/org-structure/snapshots', { method: 'POST', body: { label: formatDateTime(new Date()) } })
    notice.value = t('orgStructure.snapshotDone')
  }
  catch (err) { fail(err) }
  finally { busy.value = false }
}

function askMove(node: Node, targetId: string | null) {
  const target = targetId ? byId.value.get(targetId) ?? null : null
  moveReq.value = { node, target, descendants: descendantsOf(flat.value, node.id).length }
}

function onDragStart(id: string) {
  if (!canEditNodeId(id)) return
  dragging.value = id
}

function onDrop(targetId: string | null) {
  const id = dragging.value
  dragging.value = ''
  dropTarget.value = ''
  if (!id || id === targetId) return
  // Drop за пределы своей ветки запрещён ещё до запроса (критерий приёмки 8).
  if (targetId !== null && !canEditNodeId(targetId)) { error.value = t('orgStructure.notMyBranch'); return }
  const node = byId.value.get(id)
  if (node) askMove(node, targetId)
}

/** Итог диалога: закрыть, показать сообщение, перечитать дерево. */
async function dialogDone(message: string) {
  assignFor.value = null
  moveReq.value = null
  notice.value = message
  await load()
}

watch(tab, load)
onMounted(load)
</script>

<template>
  <div>
    <header class="head">
      <h1>{{ t('orgStructure.title') }}</h1>
      <div class="tabs" role="tablist">
        <button role="tab" :aria-selected="tab === 'view'" :class="['tab', { on: tab === 'view' }]" @click="tab = 'view'">{{ t('orgStructure.tabView') }}</button>
        <!-- Таба конструктора у рядового сотрудника нет вовсе (критерий приёмки 8) -->
        <button v-if="canEdit" role="tab" :aria-selected="tab === 'admin'" :class="['tab', { on: tab === 'admin' }]" @click="tab = 'admin'">{{ t('orgStructure.tabAdmin') }}</button>
      </div>
      <div v-if="tab === 'admin'" class="actions">
        <button v-if="tree?.canEditAll" class="btn" :disabled="busy" @click="openCreate(null)">{{ t('orgStructure.addRoot') }}</button>
        <template v-if="canImport">
          <button class="btn" :disabled="busy" @click="importOpen = true">{{ t('orgStructure.import') }}</button>
          <a class="btn" href="/api/v1/org-structure/export" download>{{ t('orgStructure.export') }}</a>
          <button class="btn" :disabled="busy" @click="snapshot">{{ t('orgStructure.snapshot') }}</button>
          <button class="btn" :disabled="busy" @click="snapshotsOpen = true">{{ t('orgStructure.snapshots') }}</button>
        </template>
      </div>
    </header>

    <p v-if="error" class="error" role="alert">{{ error }}</p>
    <p v-if="notice" class="notice" role="status">{{ notice }}</p>
    <div v-if="loadFailed" class="error" role="alert">
      {{ t('orgStructure.loadError') }}
      <button type="button" class="btn small" @click="load">{{ t('orgStructure.retry') }}</button>
    </div>

    <form v-if="tree && tree.total" class="filters" role="search" :aria-label="t('orgStructure.filters')" @submit.prevent>
      <input v-model="filters.q" type="search" :placeholder="t('orgStructure.searchPlaceholder')" :aria-label="t('orgStructure.searchPlaceholder')">
      <label>{{ t('orgStructure.location') }}
        <select v-model="filters.locationId">
          <option value="">{{ t('orgStructure.allOption') }}</option>
          <option v-for="o in optionsOf('location')" :key="o.id" :value="o.id">{{ o.name }}</option>
        </select>
      </label>
      <label>{{ t('orgStructure.unit') }}
        <select v-model="filters.orgUnitId">
          <option value="">{{ t('orgStructure.allOption') }}</option>
          <option v-for="o in optionsOf('orgUnit')" :key="o.id" :value="o.id">{{ o.name }}</option>
        </select>
      </label>
      <label>{{ t('orgStructure.position') }}
        <select v-model="filters.positionId">
          <option value="">{{ t('orgStructure.allOption') }}</option>
          <option v-for="o in optionsOf('position')" :key="o.id" :value="o.id">{{ o.name }}</option>
        </select>
      </label>
      <label class="check"><input v-model="filters.showVacant" type="checkbox"> {{ t('orgStructure.showVacant') }}</label>
      <button v-if="filtering" type="button" class="btn small" @click="resetFilters">{{ t('orgStructure.resetFilters') }}</button>
    </form>

    <div :class="['layout', { 'with-panel': form.open }]">
      <div class="tree-col">
        <!-- Скелетон из трёх уровней, пока дерево грузится впервые (`32` §5.1) -->
        <div v-if="loading && !tree" class="skeleton" aria-hidden="true">
          <span class="bone l1" /><span class="bone l2" /><span class="bone l3" /><span class="bone l2" />
        </div>
        <p v-else-if="tree && !tree.total" class="sub">{{ tab === 'admin' ? t('orgStructure.empty') : t('orgStructure.emptyView') }}</p>
        <p v-else-if="tree && filtering && !shownNodes.length" class="sub">{{ t('orgStructure.nothingFound') }}</p>

        <ul v-else-if="tree" class="tree">
          <OrgStructureNode
            v-for="n in shownNodes"
            :key="n.id"
            :node="n"
            :mode="tab"
            :editable-ids="editableIds"
            :can-edit-all="tree.canEditAll"
            :collapsed="filtering ? {} : collapsed"
            :drop-target="dropTarget"
            :my-id="me?.user.id ?? ''"
            @toggle="collapsed[$event] = !collapsed[$event]"
            @assign="assignFor = $event"
            @add="openCreate"
            @edit="openEdit"
            @archive="archive"
            @drag-start="onDragStart"
            @drag-over="dropTarget = $event"
            @drop-on="onDrop"
          />
        </ul>
      </div>

      <!-- Форма узла (`32` §6.1) — боковая панель справа, на узком экране — над деревом -->
      <aside v-if="form.open" class="card panel" :aria-label="form.id ? t('orgStructure.edit') : t('orgStructure.addChild')">
        <form class="form" @submit.prevent="save">
          <h2>{{ form.id ? t('orgStructure.edit') : t('orgStructure.addChild') }}</h2>
          <fieldset class="kinds">
            <legend>{{ t('orgStructure.kind') }}</legend>
            <label><input v-model="form.type" type="radio" value="position"> {{ t('orgStructure.kindPosition') }}</label>
            <label><input v-model="form.type" type="radio" value="employee"> {{ t('orgStructure.kindEmployee') }}</label>
          </fieldset>
          <p v-if="form.type === 'employee' && !form.id" class="sub">{{ t('orgStructure.employeeAfterSave') }}</p>
          <label>{{ t('orgStructure.position') }}
            <select v-model="form.positionId">
              <option value="">{{ t('orgStructure.noValue') }}</option>
              <option v-for="p in refs.positions" :key="p.id" :value="p.id">{{ p.name }}</option>
            </select>
          </label>
          <label>{{ t('orgStructure.nodeTitle') }}
            <input v-model="form.title" maxlength="120" :placeholder="t('orgStructure.titleHint')">
          </label>
          <label v-if="form.type === 'position'">{{ t('orgStructure.headcount') }}<input v-model.number="form.headcountPlanned" type="number" min="1" max="999"></label>
          <label class="check"><input v-model="form.isManagerPoint" type="checkbox"> {{ t('orgStructure.managerPoint') }}</label>
          <p class="sub">{{ t('orgStructure.managerPointHint') }}</p>
          <label>{{ t('orgStructure.location') }}
            <select v-model="form.locationId">
              <option value="">{{ t('orgStructure.noValue') }}</option>
              <option v-for="l in refs.locations" :key="l.id" :value="l.id">{{ l.name }}</option>
            </select>
          </label>
          <label>{{ t('orgStructure.unit') }}
            <select v-model="form.orgUnitId">
              <option value="">{{ t('orgStructure.noValue') }}</option>
              <option v-for="u in refs.units" :key="u.id" :value="u.id">{{ u.name }}</option>
            </select>
          </label>
          <label>{{ t('orgStructure.parent') }}
            <select v-model="form.parentId">
              <option v-if="tree?.canEditAll" :value="null">{{ t('orgStructure.parentRoot') }}</option>
              <option v-for="p in parentChoices" :key="p.id" :value="p.id">{{ '· '.repeat(p.depth - 1) }}{{ p.title }}</option>
            </select>
          </label>
          <label>{{ t('orgStructure.note') }}<textarea v-model="form.note" maxlength="2000" rows="2" :placeholder="t('orgStructure.noteHint')" /></label>

          <!-- Держатели узла и «Зняти з вузла» -->
          <section v-if="editedNode" class="holders" :aria-label="t('orgStructure.holders')">
            <h3>{{ t('orgStructure.holders') }}</h3>
            <p v-if="!editedNode.holders.length" class="sub">{{ t('orgStructure.noHolders') }}</p>
            <ul v-else class="holder-list">
              <li v-for="h in editedNode.holders" :key="h.assignmentId ?? h.userId">
                <span class="holder-name">{{ h.fullName }}</span>
                <span class="badge">{{ t(ROLE_LABEL[h.roleInNode] ?? 'orgStructure.roleHolder') }}</span>
                <span class="badge">{{ h.isPrimary ? t('orgStructure.primary') : t('orgStructure.secondary') }}</span>
                <button v-if="h.assignmentId" type="button" class="btn small" :disabled="busy" @click="unassign(h.assignmentId)">{{ t('orgStructure.unassign') }}</button>
              </li>
            </ul>
            <button type="button" class="btn small" :disabled="busy" @click="assignFor = editedNode">{{ t('orgStructure.assign') }}</button>
          </section>

          <div class="actions">
            <button type="button" class="btn" @click="form.open = false">{{ t('orgStructure.cancel') }}</button>
            <button type="submit" class="btn primary" :disabled="busy">{{ t('orgStructure.save') }}</button>
          </div>
        </form>
      </aside>
    </div>

    <OrgAssignDialog v-if="assignFor" :node="assignFor" :title-of="titleOf" @close="assignFor = null" @done="dialogDone" />
    <OrgMoveDialog v-if="moveReq" :node="moveReq.node" :target="moveReq.target" :descendants="moveReq.descendants" @close="moveReq = null" @done="dialogDone" />
    <OrgImportDialog v-if="importOpen" @close="importOpen = false" @changed="dialogDone" />
    <OrgSnapshotsPanel v-if="snapshotsOpen" @close="snapshotsOpen = false" @changed="dialogDone" />
  </div>
</template>

<style scoped>
.head { display: flex; align-items: center; gap: var(--space-3); margin-bottom: var(--space-3); flex-wrap: wrap; }
h1 { margin: 0; font-weight: 900; }
h2 { margin: 0; font-size: var(--font-size-body); font-weight: 800; }
h3 { margin: 0; font-size: var(--font-size-body-s); font-weight: 800; }
.tabs { display: flex; gap: var(--space-2); flex-wrap: wrap; }
.tab { font: inherit; font-weight: 700; border: 1px solid var(--color-bg-line); background: transparent; color: var(--color-ink-muted); border-radius: var(--radius-pill); padding: var(--space-1) var(--space-4); cursor: pointer; }
.tab.on { background: var(--color-ink); border-color: var(--color-ink); color: var(--color-bg-soft); }
.layout { display: grid; gap: var(--space-3); grid-template-columns: minmax(0, 1fr); }
/* На узком экране панель формы — над деревом: её не надо искать прокруткой. */
.panel { order: -1; min-width: 0; }
@media (min-width: 960px) {
  .layout.with-panel { grid-template-columns: minmax(0, 1fr) minmax(280px, 360px); align-items: start; }
  .panel { order: 0; position: sticky; top: var(--space-3); }
}
.tree-col { min-width: 0; }
.filters { display: flex; gap: var(--space-2); flex-wrap: wrap; align-items: end; margin-bottom: var(--space-3); }
.filters input[type="search"] { flex: 1 1 220px; }
.filters label { display: grid; gap: var(--space-1); font-size: var(--font-size-body-s); color: var(--color-ink-muted); min-width: 0; }
.filters .check { display: flex; align-items: center; gap: var(--space-2); color: var(--color-ink); }
.skeleton { display: grid; gap: var(--space-2); }
.bone { display: block; height: var(--space-6); border-radius: var(--radius-m); background: var(--color-bg-line-soft); }
.bone.l2 { margin-left: var(--space-5); }
.bone.l3 { margin-left: calc(2 * var(--space-5)); }
.tree { list-style: none; margin: 0; padding: 0; }
.card { background: var(--color-bg-soft); border-radius: var(--radius-m); padding: var(--space-3); }
.form { display: grid; gap: var(--space-2); }
.form label { display: grid; gap: var(--space-1); font-size: var(--font-size-body-s); color: var(--color-ink-muted); min-width: 0; }
.check { display: flex !important; align-items: center; gap: var(--space-2); color: var(--color-ink) !important; }
.kinds { border: 1px solid var(--color-bg-line); border-radius: var(--radius-s); padding: var(--space-2); display: flex; gap: var(--space-3); flex-wrap: wrap; }
.kinds legend { font-size: var(--font-size-body-s); color: var(--color-ink-muted); }
input, textarea, select { font: inherit; border: 1px solid var(--color-bg-line); border-radius: var(--radius-s); padding: var(--space-1) var(--space-2); background: var(--color-bg); color: var(--color-ink); min-width: 0; max-width: 100%; box-sizing: border-box; }
input[type="checkbox"], input[type="radio"] { width: auto; }
.holders { display: grid; gap: var(--space-2); border-top: 1px solid var(--color-bg-line); padding-top: var(--space-2); }
.holder-list { list-style: none; margin: 0; padding: 0; display: grid; gap: var(--space-1); }
.holder-list li { display: flex; align-items: center; gap: var(--space-2); flex-wrap: wrap; }
.holder-name { font-weight: 700; overflow-wrap: anywhere; }
.btn { font: inherit; font-weight: 700; border: 1px solid var(--color-bg-line); background: var(--color-bg-soft); color: var(--color-ink); border-radius: var(--radius-pill); padding: var(--space-1) var(--space-4); cursor: pointer; text-decoration: none; }
.btn.primary { background: var(--color-sun); border-color: var(--color-sun); }
.btn.small { font-size: var(--font-size-body-s); padding: 0 var(--space-3); }
.btn:disabled { opacity: 0.5; }
.actions { display: flex; gap: var(--space-2); flex-wrap: wrap; }
.sub { color: var(--color-ink-faint); font-size: var(--font-size-body-s); margin: 0; }
.error { background: var(--color-coral); color: var(--color-coral-deep); padding: var(--space-3); border-radius: var(--radius-m); }
.notice { color: var(--color-teal-ink); }
</style>
