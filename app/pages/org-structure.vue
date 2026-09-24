<script setup lang="ts">
/**
 * `/org-structure` — дерево подчинения (docs/v2/32-org-structure.md §5).
 *
 * Два таба одного дерева: «Співробітник — перегляд» видят все роли (`org.structure.view`),
 * «Адмін — конструктор» — только `org.structure.edit`. У рядового сотрудника таб
 * конструктора **не отрисован вовсе**, и иконок управления на карточках нет (критерий
 * приёмки 8) — это не «кнопка, которая ничего не делает», а отсутствие кнопки.
 *
 * Руководителю доступна своя ветка: сервер возвращает её пути в `branches`, drop за её
 * пределы блокируется с подсказкой «Ви можете змінювати лише свою гілку». Право всё равно
 * проверяется на сервере (`canEditNode()`); здесь — чтобы человек не тащил карточку впустую.
 */
definePageMeta({ layout: 'learner' })

const { t } = useI18n()
const { api } = useApi()
const { hasScope, me } = useAuth()

interface Holder { userId: string, fullName: string, email: string | null, roleInNode: string, isPrimary: boolean }
interface Node {
  id: string
  parentId: string | null
  depth: number
  type: 'position' | 'employee'
  title: string
  note?: string | null
  positionName: string | null
  locationName: string | null
  orgUnitName: string | null
  headcountPlanned: number
  headcountActual: number
  isManagerPoint: boolean
  state: 'vacant' | 'occupied' | 'archived'
  holders: Holder[]
  children: Node[]
}
interface Tree { nodes: Node[], total: number, mode: 'admin' | 'view', canEditAll: boolean, branches: string[] }

const canEdit = computed(() => hasScope('org.structure.edit'))
const tab = ref<'view' | 'admin'>('view')
const tree = ref<Tree | null>(null)
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
  parentId: '' as string | null,
  id: '',
  type: 'position' as 'position' | 'employee',
  title: '',
  headcountPlanned: 1,
  isManagerPoint: false,
  note: '',
})

async function load() {
  error.value = ''
  try {
    const mode = tab.value === 'admin' && canEdit.value ? 'admin' : 'view'
    const data = await api<Tree>('/org-structure/tree', { query: { mode } })
    tree.value = data
    // Права на конкретный узел: либо весь тенант, либо поддеревья, где человек держатель.
    if (data.canEditAll) editableIds.value = new Set(allIds(data.nodes))
    else editableIds.value = branchIds(data.nodes, data.branches)
  }
  catch (err) { error.value = apiErrorOf(err).message }
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

function openCreate(parentId: string | null) {
  Object.assign(form, { open: true, id: '', parentId, type: 'position', title: '', headcountPlanned: 1, isManagerPoint: false, note: '' })
}

function openEdit(n: Node) {
  Object.assign(form, { open: true, id: n.id, parentId: n.parentId, type: n.type, title: n.title, headcountPlanned: n.headcountPlanned, isManagerPoint: n.isManagerPoint, note: n.note ?? '' })
}

function fail(err: unknown) {
  const e = apiErrorOf(err)
  const key = `orgStructure.err.${e.code}`
  const text = t(key)
  error.value = text === key ? e.message : text
}

async function save() {
  busy.value = true
  error.value = ''
  try {
    const body = { type: form.type, title: form.title, headcountPlanned: form.headcountPlanned, isManagerPoint: form.isManagerPoint, note: form.note || null }
    if (form.id) await api(`/org-structure/nodes/${form.id}`, { method: 'PUT', body })
    else await api('/org-structure/nodes', { method: 'POST', body: { ...body, parentId: form.parentId } })
    form.open = false
    await load()
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

async function snapshot() {
  busy.value = true
  error.value = ''
  try {
    await api('/org-structure/snapshots', { method: 'POST', body: { label: new Date().toISOString().slice(0, 16).replace('T', ' ') } })
    notice.value = t('orgStructure.snapshotDone')
  }
  catch (err) { fail(err) }
  finally { busy.value = false }
}

function onDragStart(id: string) {
  if (!canEditNodeId(id)) return
  dragging.value = id
}

async function onDrop(targetId: string | null) {
  const id = dragging.value
  dragging.value = ''
  dropTarget.value = ''
  if (!id || id === targetId) return
  // Drop за пределы своей ветки запрещён ещё до запроса (критерий приёмки 8).
  if (targetId !== null && !canEditNodeId(targetId)) { error.value = t('orgStructure.notMyBranch'); return }
  busy.value = true
  error.value = ''
  try { await api(`/org-structure/nodes/${id}/move`, { method: 'POST', body: { parentId: targetId } }); await load() }
  catch (err) { fail(err) }
  finally { busy.value = false }
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
      <div v-if="tab === 'admin' && tree?.canEditAll" class="actions">
        <button class="btn" :disabled="busy" @click="openCreate(null)">{{ t('orgStructure.addRoot') }}</button>
        <button class="btn" :disabled="busy" @click="snapshot">{{ t('orgStructure.snapshot') }}</button>
      </div>
    </header>

    <p v-if="error" class="error" role="alert">{{ error }}</p>
    <p v-if="notice" class="notice" role="status">{{ notice }}</p>

    <p v-if="tree && !tree.total" class="sub">{{ tab === 'admin' ? t('orgStructure.empty') : t('orgStructure.emptyView') }}</p>

    <ul v-else-if="tree" class="tree">
      <OrgStructureNode
        v-for="n in tree.nodes"
        :key="n.id"
        :node="n"
        :mode="tab"
        :editable-ids="editableIds"
        :can-edit-all="tree.canEditAll"
        :collapsed="collapsed"
        :drop-target="dropTarget"
        :my-id="me?.user.id ?? ''"
        @toggle="collapsed[$event] = !collapsed[$event]"
        @add="openCreate"
        @edit="openEdit"
        @archive="archive"
        @drag-start="onDragStart"
        @drag-over="dropTarget = $event"
        @drop-on="onDrop"
      />
    </ul>

    <section v-if="form.open" class="card form-card">
      <form class="form" @submit.prevent="save">
        <h2>{{ form.id ? t('orgStructure.edit') : t('orgStructure.addChild') }}</h2>
        <fieldset class="kinds">
          <legend>{{ t('orgStructure.kind') }}</legend>
          <label><input v-model="form.type" type="radio" value="position"> {{ t('orgStructure.kindPosition') }}</label>
          <label><input v-model="form.type" type="radio" value="employee"> {{ t('orgStructure.kindEmployee') }}</label>
        </fieldset>
        <label>{{ t('orgStructure.nodeTitle') }}<input v-model="form.title" required minlength="2" maxlength="120"></label>
        <label v-if="form.type === 'position'">{{ t('orgStructure.headcount') }}<input v-model.number="form.headcountPlanned" type="number" min="1" max="999"></label>
        <label class="check"><input v-model="form.isManagerPoint" type="checkbox"> {{ t('orgStructure.managerPoint') }}</label>
        <p class="sub">{{ t('orgStructure.managerPointHint') }}</p>
        <label>{{ t('orgStructure.note') }}<textarea v-model="form.note" maxlength="2000" rows="2" /></label>
        <div class="actions">
          <button type="button" class="btn" @click="form.open = false">{{ t('orgStructure.cancel') }}</button>
          <button type="submit" class="btn primary" :disabled="busy">{{ t('orgStructure.save') }}</button>
        </div>
      </form>
    </section>
  </div>
</template>

<style scoped>
.head { display: flex; align-items: center; gap: var(--space-3); margin-bottom: var(--space-3); flex-wrap: wrap; }
h1 { margin: 0; font-weight: 900; }
h2 { margin: 0; font-size: var(--font-size-body); font-weight: 800; }
.tabs { display: flex; gap: var(--space-2); flex-wrap: wrap; }
.tab { font: inherit; font-weight: 700; border: 1px solid var(--color-bg-line); background: transparent; color: var(--color-ink-muted); border-radius: var(--radius-pill); padding: var(--space-1) var(--space-4); cursor: pointer; }
.tab.on { background: var(--color-ink); border-color: var(--color-ink); color: var(--color-bg-soft); }
.tree { list-style: none; margin: 0; padding: 0; }
.card { background: var(--color-bg-soft); border-radius: var(--radius-m); padding: var(--space-3); margin-top: var(--space-3); }
.form { display: grid; gap: var(--space-2); }
.form label { display: grid; gap: var(--space-1); font-size: var(--font-size-body-s); color: var(--color-ink-muted); }
.check { display: flex !important; align-items: center; gap: var(--space-2); color: var(--color-ink) !important; }
.kinds { border: 1px solid var(--color-bg-line); border-radius: var(--radius-s); padding: var(--space-2); display: flex; gap: var(--space-3); flex-wrap: wrap; }
.kinds legend { font-size: var(--font-size-body-s); color: var(--color-ink-muted); }
input, textarea { font: inherit; border: 1px solid var(--color-bg-line); border-radius: var(--radius-s); padding: var(--space-1) var(--space-2); background: var(--color-bg); color: var(--color-ink); min-width: 0; box-sizing: border-box; }
input[type="checkbox"], input[type="radio"] { width: auto; }
.btn { font: inherit; font-weight: 700; border: 1px solid var(--color-bg-line); background: var(--color-bg-soft); color: var(--color-ink); border-radius: var(--radius-pill); padding: var(--space-1) var(--space-4); cursor: pointer; }
.btn.primary { background: var(--color-sun); border-color: var(--color-sun); }
.btn:disabled { opacity: 0.5; }
.actions { display: flex; gap: var(--space-2); flex-wrap: wrap; }
.sub { color: var(--color-ink-faint); font-size: var(--font-size-body-s); margin: 0; }
.error { background: var(--color-coral); color: var(--color-coral-deep); padding: var(--space-3); border-radius: var(--radius-m); }
.notice { color: var(--color-teal-ink); }
</style>
