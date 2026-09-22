<script setup lang="ts">
/**
 * Дерево цілей «Стратегічний план» (докс/19 §14.4, мокап `Goals`): цілі компанії («Напрямок»)
 * каскадом розкриваються до особистих цілей людей — вкладеність через parentId, статуси й
 * протокол — той самий механізм, що й у ІПР (goal_statuses/goal_status_log).
 */
definePageMeta({ layout: 'admin', middleware: 'admin-scope', requiredScope: 'development.team' })
const { t } = useI18n()
const { api } = useApi()
const { hasScope } = useAuth()

interface TreeGoal {
  id: string, parentId: string | null, title: string, userId: string, ownerName: string | null,
  dueAt: string | null, statusCode: string, statusName: string, statusColor: string,
  isFinal: boolean, isSuccess: boolean, progressPct: number, createdAt: string,
}
interface Status { code: string, name: string, color: string, isInitial: boolean }

const items = ref<TreeGoal[]>([])
const statuses = ref<Status[]>([])
const error = ref('')
const canManage = computed(() => hasScope('development.manage'))

async function load() {
  try {
    const r = await api<{ items: TreeGoal[], statuses: Status[] }>('/development/goals/tree')
    items.value = r.items
    statuses.value = r.statuses
  }
  catch (err) { error.value = apiErrorOf(err).message }
}
onMounted(load)

const flat = computed(() => {
  const byParent = new Map<string | null, TreeGoal[]>()
  for (const it of items.value) {
    const key = it.parentId
    if (!byParent.has(key)) byParent.set(key, [])
    byParent.get(key)!.push(it)
  }
  const out: (TreeGoal & { depth: number })[] = []
  const walk = (parentId: string | null, depth: number) => {
    for (const n of byParent.get(parentId) ?? []) { out.push({ ...n, depth }); walk(n.id, depth + 1) }
  }
  walk(null, 0)
  return out
})

const people = ref<{ id: string, fullName: string }[]>([])
async function ensurePeople() { if (!people.value.length) people.value = await api<{ id: string, fullName: string }[]>('/people', { query: { limit: 300 } }).catch(() => []) }

const editing = ref(false)
const form = reactive({ id: '', parentId: null as string | null, title: '', userId: '', dueAt: '', progressPct: 0 })
async function openCreate(parentId: string | null) {
  await ensurePeople()
  Object.assign(form, { id: '', parentId, title: '', userId: '', dueAt: '', progressPct: 0 })
  editing.value = true
}
async function openEdit(g: TreeGoal) {
  await ensurePeople()
  Object.assign(form, { id: g.id, parentId: g.parentId, title: g.title, userId: g.userId, dueAt: g.dueAt ?? '', progressPct: g.progressPct })
  editing.value = true
}
async function save() {
  error.value = ''
  try {
    if (form.id) {
      await api(`/development/goals/tree/${form.id}`, { method: 'PATCH', body: { title: form.title, userId: form.userId, dueAt: form.dueAt || null, progressPct: form.progressPct } })
    }
    else {
      await api('/development/goals/tree', { method: 'POST', body: { parentId: form.parentId, title: form.title, userId: form.userId, dueAt: form.dueAt || null } })
    }
    editing.value = false
    await load()
  }
  catch (err) { error.value = apiErrorOf(err).message }
}
async function remove(g: TreeGoal) {
  if (!confirm(t('dev.deleteGoalConfirm', { title: g.title }))) return
  try { await api(`/development/goals/tree/${g.id}`, { method: 'DELETE' }); await load() }
  catch (err) { error.value = apiErrorOf(err).message }
}
async function setStatus(g: TreeGoal, code: string) {
  error.value = ''
  try { await api(`/development/goals/${g.id}/transition`, { method: 'POST', body: { to: code } }); await load() }
  catch (err) { error.value = apiErrorOf(err).message }
}
</script>
<template>
  <div>
    <header class="head">
      <div>
        <div class="eyebrow">{{ t('dev.strategicEyebrow') }}</div>
        <h1>{{ t('dev.strategicTreeTitle') }}</h1>
      </div>
    </header>
    <p v-if="error" class="error" role="alert">{{ error }}</p>
    <div class="layout">
      <div class="tree-col">
        <div v-for="g in flat" :key="g.id" class="node" :style="{ marginLeft: `${g.depth * 26}px` }">
          <div class="bar" :class="g.statusColor" />
          <div class="grow" @click="canManage && openEdit(g)">
            <div class="title">{{ g.title }}</div>
            <div class="sub">{{ g.depth === 0 ? t('dev.direction') : (g.ownerName ?? '—') }}<template v-if="g.depth === 0 && g.ownerName"> · {{ g.ownerName }}</template><template v-if="g.dueAt"> · {{ t('dev.due') }} {{ g.dueAt }}</template><template v-else-if="g.depth > 0"> · {{ t('dev.noDue') }}</template></div>
          </div>
          <div class="progress"><div class="bar-track"><div class="bar-fill" :style="{ width: `${g.progressPct}%` }" /></div></div>
          <select v-if="canManage" class="status-select" :value="g.statusCode" @change="setStatus(g, ($event.target as HTMLSelectElement).value)">
            <option v-for="s in statuses" :key="s.code" :value="s.code">{{ s.name }}</option>
          </select>
          <span v-else :class="['badge', g.statusColor]">{{ g.statusName }}</span>
          <div v-if="canManage" class="node-actions">
            <button class="icon-btn" :title="t('dev.addSubgoal')" @click="openCreate(g.id)">+</button>
            <button class="icon-btn danger" :title="t('groups.delete')" @click="remove(g)">×</button>
          </div>
        </div>
        <button v-if="canManage" type="button" class="add-root" @click="openCreate(null)">{{ t('dev.addRootGoal') }}</button>
      </div>
      <aside class="side-col">
        <section class="panel">
          <h2>{{ t('admin.nav.goalStatuses') }}</h2>
          <p class="sub">{{ t('dev.goalStatusesDictHint') }}</p>
          <ul class="status-list">
            <li v-for="s in statuses" :key="s.code">
              <span class="dot" :class="s.color" />
              <span class="grow">{{ s.name }}</span>
              <span v-if="s.isInitial" class="badge muted">{{ t('dev.defaultStatus') }}</span>
            </li>
          </ul>
        </section>
        <section class="panel">
          <h2>{{ t('dev.protocolTitle') }}</h2>
          <p class="protocol-text">{{ t('dev.protocolHint') }}</p>
        </section>
      </aside>
    </div>

    <div v-if="editing" class="overlay" @click.self="editing = false">
      <form class="modal" role="dialog" aria-modal="true" @submit.prevent="save">
        <h2>{{ form.id ? t('common.edit') : (form.parentId ? t('dev.addSubgoal') : t('dev.addRootGoal')) }}</h2>
        <label>{{ t('dev.goalTitle') }}<input v-model="form.title" required minlength="3" maxlength="200" class="field"></label>
        <label>{{ t('dev.goalOwner') }}
          <select v-model="form.userId" required class="field">
            <option value="" disabled>—</option>
            <option v-for="u in people" :key="u.id" :value="u.id">{{ u.fullName }}</option>
          </select>
        </label>
        <label>{{ t('dev.due') }}<input v-model="form.dueAt" type="date" class="field"></label>
        <label v-if="form.id">{{ t('dev.progress') }}<input v-model.number="form.progressPct" type="number" min="0" max="100" class="field"></label>
        <div class="row2"><button type="button" class="chip" @click="editing = false">{{ t('common.cancel') }}</button><button type="submit" class="primary" :disabled="form.title.length < 3 || !form.userId">{{ t('common.save') }}</button></div>
      </form>
    </div>
  </div>
</template>
<style scoped>
.head { display: flex; align-items: flex-end; justify-content: space-between; gap: var(--space-3); margin-bottom: var(--space-3); flex-wrap: wrap; }
.eyebrow { font-size: var(--font-size-body-s); font-weight: 700; color: var(--color-ink-muted); }
h1 { margin: 0; font-weight: 900; }
h2 { margin: 0 0 var(--space-1); font-weight: 900; font-size: var(--font-size-body); }
.layout { display: flex; gap: var(--space-4); align-items: flex-start; flex-wrap: wrap; }
.tree-col { flex: 1 1 480px; min-width: 0; }
.side-col { width: 320px; flex-shrink: 0; display: grid; gap: var(--space-3); }
.node { display: flex; align-items: center; gap: var(--space-3); background: var(--color-bg-soft); border: 1px solid var(--color-bg-line); border-radius: var(--radius-l); padding: var(--space-3); margin-bottom: var(--space-2); cursor: default; }
.bar { width: 8px; align-self: stretch; border-radius: var(--radius-pill); background: var(--color-bg-line-soft); flex-shrink: 0; }
.bar.teal { background: var(--color-teal); }
.bar.sun { background: var(--color-sun); }
.bar.coral { background: var(--color-coral); }
.grow { flex: 1; min-width: 0; cursor: pointer; }
.title { font-weight: 800; }
.sub { font-size: var(--font-size-body-s); color: var(--color-ink-faint); margin-top: 2px; }
.progress { width: 120px; flex-shrink: 0; }
.bar-track { height: 8px; background: var(--color-bg-line-soft); border-radius: var(--radius-pill); overflow: hidden; }
.bar-fill { height: 100%; background: var(--color-teal); border-radius: var(--radius-pill); }
.status-select { font: inherit; font-size: var(--font-size-body-s); border: 1px solid var(--color-bg-line); border-radius: var(--radius-pill); padding: var(--space-1) var(--space-2); background: var(--color-bg); color: var(--color-ink); flex-shrink: 0; }
.badge { font-size: var(--font-size-body-s); font-weight: 700; border-radius: var(--radius-pill); padding: 2px var(--space-3); background: var(--color-bg-line-soft); white-space: nowrap; flex-shrink: 0; }
.badge.teal { background: var(--color-teal); color: var(--color-teal-deep); }
.badge.sun { background: var(--color-sun); color: var(--color-sun-ink); }
.badge.coral { background: var(--color-coral); color: var(--color-coral-deep); }
.badge.muted { background: var(--color-bg-line-soft); color: var(--color-ink-muted); }
.node-actions { display: flex; gap: var(--space-1); flex-shrink: 0; }
.icon-btn { font: inherit; font-weight: 800; border: 1px solid var(--color-bg-line); background: transparent; color: var(--color-ink-muted); border-radius: var(--radius-s); width: 28px; height: 28px; cursor: pointer; }
.icon-btn.danger { color: var(--color-coral-ink); }
.add-root { font: inherit; font-weight: 800; border: none; background: var(--color-sun); color: var(--color-ink); border-radius: var(--radius-m); padding: var(--space-2) var(--space-4); cursor: pointer; margin-top: var(--space-2); }
.panel { background: var(--color-bg-soft); border: 1px solid var(--color-bg-line); border-radius: var(--radius-l); padding: var(--space-4); }
.status-list { list-style: none; margin: var(--space-3) 0 0; padding: 0; display: grid; gap: var(--space-1); }
.status-list li { display: flex; align-items: center; gap: var(--space-2); padding: var(--space-2) 0; border-bottom: 1px solid var(--color-bg-line-soft); }
.dot { width: 10px; height: 10px; border-radius: 999px; background: var(--color-bg-line-soft); flex-shrink: 0; }
.dot.teal { background: var(--color-teal); }
.dot.sun { background: var(--color-sun); }
.dot.coral { background: var(--color-coral); }
.protocol-text { font-size: var(--font-size-body-s); line-height: 1.4; color: var(--color-ink); margin: var(--space-3) 0 0; }
.error { color: var(--color-coral-ink); }
.chip { font: inherit; font-size: var(--font-size-body-s); font-weight: 700; border: 1px solid var(--color-bg-line); background: transparent; color: var(--color-ink-muted); border-radius: var(--radius-pill); padding: var(--space-1) var(--space-3); cursor: pointer; }
.primary { font: inherit; font-weight: 800; border: none; background: var(--color-sun); color: var(--color-ink); border-radius: var(--radius-pill); padding: var(--space-2) var(--space-4); cursor: pointer; }
.primary:disabled { opacity: 0.5; }
.overlay { position: fixed; inset: 0; background: rgb(0 0 0 / 40%); display: grid; place-items: center; padding: var(--space-3); z-index: 20; overflow: auto; }
.modal { background: var(--color-bg-soft); border-radius: var(--radius-l); padding: var(--space-4); display: grid; gap: var(--space-2); width: min(480px, 100%); box-sizing: border-box; max-height: 100%; overflow: auto; }
.modal label { display: grid; gap: var(--space-1); font-size: var(--font-size-body-s); color: var(--color-ink-muted); }
.field { font: inherit; border: 1px solid var(--color-bg-line); border-radius: var(--radius-s); padding: var(--space-1) var(--space-2); background: var(--color-bg); color: var(--color-ink); min-width: 0; box-sizing: border-box; }
.row2 { display: flex; gap: var(--space-2); justify-content: flex-end; }
@media (max-width: 900px) {
  .side-col { width: 100%; }
}
</style>
