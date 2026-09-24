<script setup lang="ts">
const { formatDateTime } = useFormat()
definePageMeta({ layout: 'admin', middleware: 'admin-scope', requiredScope: 'program.manage' })
const { t } = useI18n()
const { api } = useApi()
const { hasScope } = useAuth()
const route = useRoute()
interface Node { id: string, nodeType: string, itemType: string | null, itemId: string | null, itemTitle: string | null, titleOverride: string | null, sort: number, position: { x: number, y: number }, isRequired: boolean, dueDays: number | null }
interface Edge { id: string, fromNodeId: string, toNodeId: string, condition: { type: string, value?: number }, sort: number }
interface Program { id: string, title: string, description: string | null, mode: string, status: string, tags: string[], code: string | null, workload: string | null, assignmentMode: string[], automationRuleId: string | null, noAssignAfterFinish: boolean, countPriorResults: boolean, validityMonths: number | null, dueDays: number | null, updatedAt: string, version: number, nodes: Node[], edges: Edge[], rule: { id: string, name: string } | null }
const p = ref<Program | null>(null)
const content = ref<{ type: string, id: string, title: string }[]>([])
const rules = ref<{ id: string, name: string }[]>([])
const error = ref('')
const notice = ref('')
const problems = ref<{ code: string, nodeId?: string, message: string }[]>([])
const add = reactive({ id: '', title: '' })
const selected = ref<string | null>(null)
const linking = ref<string | null>(null)
const newEdge = reactive({ condition: 'always', value: 80 })
const settings = reactive({ title: '', description: '', tags: '', code: '', workload: '', assignmentMode: ['manual'] as string[], automationRuleId: '', noAssignAfterFinish: false, countPriorResults: true, dueDays: null as number | null, validityMonths: null as number | null })
const id = String(route.params.id)

async function load() {
  try {
    p.value = await api<Program>(`/programs/${id}`)
    Object.assign(settings, { title: p.value.title, description: p.value.description ?? '', tags: p.value.tags.join(', '), code: p.value.code ?? '', workload: p.value.workload ?? '', assignmentMode: [...p.value.assignmentMode], automationRuleId: p.value.automationRuleId ?? '', noAssignAfterFinish: p.value.noAssignAfterFinish, countPriorResults: p.value.countPriorResults, dueDays: p.value.dueDays, validityMonths: p.value.validityMonths })
    problems.value = await api(`/programs/${id}/validate`)
  } catch (err) { error.value = apiErrorOf(err).message }
}
onMounted(async () => {
  await load()
  try {
    const [courses, quizzes, workshops, meetups] = await Promise.all([
      api<{ id: string, title: string, status: string }[]>('/courses'), api<{ id: string, title: string, status: string }[]>('/quizzes'), api<{ id: string, title: string }[]>('/workshops'),
      api<{ id: string, title: string, kind: string }[]>(`/meetups?from=${new Date().toISOString().slice(0, 10)}&to=${new Date(Date.now() + 180 * 86_400_000).toISOString().slice(0, 10)}`),
    ])
    content.value = [...courses.filter(c => c.status === 'published').map(c => ({ type: 'course', id: c.id, title: c.title })), ...quizzes.filter(q => q.status === 'published').map(q => ({ type: 'quiz', id: q.id, title: q.title })), ...workshops.map(w => ({ type: 'workshop', id: w.id, title: w.title })), ...meetups.map(m => ({ type: m.kind === 'webinar' ? 'webinar' : 'meetup', id: m.id, title: m.title }))]
    rules.value = await api('/automation-rules')
  } catch { /* часть справочников недоступна по правам */ }
})
async function run(fn: () => Promise<unknown>, ok = t('common.saved')) { error.value = ''; notice.value = ''; try { await fn(); notice.value = ok; await load() } catch (err) { error.value = apiErrorOf(err).message } }
const items = computed(() => p.value?.nodes.filter(n => n.nodeType === 'item').sort((a, b) => a.sort - b.sort) ?? [])
const addNode = () => run(async () => { const c = content.value.find(x => x.id === add.id); await api(`/programs/${id}/nodes`, { method: 'PUT', body: { itemType: c?.type ?? 'course', itemId: add.id, titleOverride: add.title || null } }); add.id = ''; add.title = '' })
const removeNode = (n: Node) => run(() => api(`/programs/${id}/nodes/${n.id}`, { method: 'DELETE' }))
const patchNode = (n: Node, patch: Record<string, unknown>) => run(() => api(`/programs/${id}/nodes`, { method: 'PUT', body: { id: n.id, itemType: n.itemType, itemId: n.itemId, titleOverride: n.titleOverride, isRequired: n.isRequired, dueDays: n.dueDays, ...patch } }))
function move(i: number, dir: -1 | 1) { const ids = items.value.map(n => n.id); const j = i + dir; if (j < 0 || j >= ids.length) return; [ids[i], ids[j]] = [ids[j]!, ids[i]!]; run(() => api(`/programs/${id}/nodes`, { method: 'PUT', body: { reorder: ids } })) }
const removeEdge = (e: Edge) => run(() => api(`/programs/${id}/edges/${e.id}`, { method: 'DELETE' }))
function startLink(nodeId: string) { if (linking.value === nodeId) { linking.value = null; return } if (!linking.value) { linking.value = nodeId; return } const from = linking.value; linking.value = null; run(() => api(`/programs/${id}/edges`, { method: 'PUT', body: { fromNodeId: from, toNodeId: nodeId, condition: newEdge.condition === 'score_gte' ? { type: 'score_gte', value: newEdge.value } : { type: newEdge.condition } } })) }
const saveSettings = () => run(() => api(`/programs/${id}`, { method: 'PATCH', body: { title: settings.title, description: settings.description || null, tags: settings.tags.split(',').map(s => s.trim()).filter(Boolean), code: settings.code.trim() || null, workload: settings.workload.trim() || null, assignmentMode: settings.assignmentMode, ...(hasScope('program.link_rule') ? { automationRuleId: settings.automationRuleId || null } : {}), noAssignAfterFinish: settings.noAssignAfterFinish, countPriorResults: settings.countPriorResults, dueDays: settings.dueDays || null, validityMonths: settings.validityMonths || null } }))
const publish = () => run(async () => { try { await api(`/programs/${id}/publish`, { method: 'POST' }) } catch (err) { const e = apiErrorOf(err); problems.value = (e.details?.problems as typeof problems.value) ?? []; throw err } }, t('prog.published'))
const unpublish = () => run(() => api(`/programs/${id}`, { method: 'PATCH', body: { status: 'draft' } }))
// Автовыравнивание: слои по расстоянию от Start
function autoLayout() {
  if (!p.value) return
  const start = p.value.nodes.find(n => n.nodeType === 'start')!
  const depth = new Map<string, number>([[start.id, 0]])
  const q = [start.id]
  while (q.length) { const cur = q.shift()!; for (const e of p.value.edges.filter(e => e.fromNodeId === cur)) if (!depth.has(e.toNodeId)) { depth.set(e.toNodeId, depth.get(cur)! + 1); q.push(e.toNodeId) } }
  const finish = p.value.nodes.find(n => n.nodeType === 'finish')!
  const maxD = Math.max(...depth.values(), 0) + 1
  depth.set(finish.id, maxD)
  const cols = new Map<number, number>()
  const updates = p.value.nodes.map((n) => { const d = depth.get(n.id) ?? maxD - 0.5; const k = (cols.get(d) ?? 0); cols.set(d, k + 1); return { n, x: 40 + d * 200, y: 60 + k * 110 } })
  run(async () => { for (const u of updates) if (u.n.nodeType === 'item') await api(`/programs/${id}/nodes`, { method: 'PUT', body: { id: u.n.id, itemType: u.n.itemType, itemId: u.n.itemId, position: { x: u.x, y: u.y } } }) })
}
const nodeTitle = (n: Node) => n.nodeType === 'start' ? 'Start' : n.nodeType === 'finish' ? 'Finish' : (n.titleOverride || n.itemTitle || '?')
const pos = (nid: string) => p.value?.nodes.find(n => n.id === nid)?.position ?? { x: 0, y: 0 }
const condLabel = (c: Edge['condition']) => c.type === 'always' ? '' : c.type === 'score_gte' ? `≥${c.value}%` : t(`prog.cond.${c.type}`)
const selectedNode = computed(() => p.value?.nodes.find(n => n.id === selected.value && n.nodeType === 'item') ?? null)
// Перетаскивание на канве
const drag = ref<{ id: string, dx: number, dy: number } | null>(null)
function onDown(n: Node, e: MouseEvent) { if (n.nodeType !== 'item') return; drag.value = { id: n.id, dx: e.offsetX - n.position.x, dy: e.offsetY - n.position.y } }
function onMove(e: MouseEvent) { if (!drag.value || !p.value) return; const n = p.value.nodes.find(x => x.id === drag.value!.id)!; n.position = { x: Math.max(0, e.offsetX - drag.value.dx), y: Math.max(0, e.offsetY - drag.value.dy) } }
function onUp() { if (!drag.value || !p.value) return; const n = p.value.nodes.find(x => x.id === drag.value!.id)!; drag.value = null; api(`/programs/${id}/nodes`, { method: 'PUT', body: { id: n.id, itemType: n.itemType, itemId: n.itemId, position: n.position } }).catch(() => {}) }
</script>
<template>
  <div>
    <NuxtLink to="/admin/programs" class="back">← {{ t('admin.nav.programs') }}</NuxtLink>
    <p v-if="error" class="error">{{ error }}</p>
    <p v-if="notice" class="notice">{{ notice }}</p>
    <template v-if="p">
      <div class="head"><h1>{{ p.title }}</h1><span :class="['badge', p.status]">{{ t(`course.status.${p.status}`) }} · v{{ p.version }}</span></div>
      <div class="layout">
        <section class="main">
          <div class="row">
            <h2>{{ t(`prog.modes.${p.mode}`) }}</h2>
            <span class="spacer" />
            <button v-if="p.mode === 'graph'" class="chip" @click="autoLayout">{{ t('prog.autoLayout') }}</button>
            <button v-if="p.status !== 'published'" class="primary" :disabled="!!problems.filter(x => x.code !== 'ambiguous').length" data-testid="prog-publish" @click="publish">{{ t('prog.publish') }}</button>
            <button v-else class="chip" @click="unpublish">{{ t('prog.unpublish') }}</button>
          </div>
          <ul v-if="problems.length" class="problems"><li v-for="(pr, i) in problems" :key="i" :class="pr.code === 'ambiguous' ? 'warn' : 'bad'">{{ pr.message }}</li></ul>

          <!-- Линейный режим: список с порядком -->
          <ol v-if="p.mode === 'linear'" class="linear">
            <li v-for="(n, i) in items" :key="n.id" class="item">
              <span class="num">{{ i + 1 }}</span>
              <div class="body">
                <input :value="n.titleOverride ?? ''" class="field" :placeholder="n.itemTitle ?? ''" @change="patchNode(n, { titleOverride: ($event.target as HTMLInputElement).value || null })">
                <span class="sub">{{ t(`prog.itemType.${n.itemType}`) }} · {{ n.itemTitle }}</span>
                <div class="row">
                  <label class="check"><input type="checkbox" :checked="n.isRequired" @change="patchNode(n, { isRequired: ($event.target as HTMLInputElement).checked })"> {{ t('prog.required') }}</label>
                  <label class="sub">{{ t('prog.dueDays') }} <input :value="n.dueDays ?? ''" class="field short" type="number" min="1" @change="patchNode(n, { dueDays: Number(($event.target as HTMLInputElement).value) || null })"></label>
                  <button class="chip" @click="move(i, -1)">↑</button><button class="chip" @click="move(i, 1)">↓</button><button class="chip danger" @click="removeNode(n)">✕</button>
                </div>
              </div>
            </li>
          </ol>

          <!-- Граф: канва -->
          <div v-else class="canvas-wrap">
            <svg class="canvas" viewBox="0 0 1000 520" @mousemove="onMove" @mouseup="onUp" @mouseleave="onUp">
              <defs><marker id="arrow" viewBox="0 0 10 10" refX="9" refY="5" markerWidth="8" markerHeight="8" orient="auto"><path d="M0,0 L10,5 L0,10 z" fill="var(--color-ink-muted)" /></marker></defs>
              <g v-for="e in p.edges" :key="e.id" class="edge" @click="removeEdge(e)">
                <line :x1="pos(e.fromNodeId).x + 150" :y1="pos(e.fromNodeId).y + 30" :x2="pos(e.toNodeId).x" :y2="pos(e.toNodeId).y + 30" stroke="var(--color-ink-muted)" stroke-width="2" marker-end="url(#arrow)" />
                <text :x="(pos(e.fromNodeId).x + 150 + pos(e.toNodeId).x) / 2" :y="(pos(e.fromNodeId).y + pos(e.toNodeId).y) / 2 + 24" text-anchor="middle" font-size="11" fill="var(--color-coral-deep)">{{ condLabel(e.condition) }}</text>
              </g>
              <g v-for="n in p.nodes" :key="n.id" :transform="`translate(${n.position.x},${n.position.y})`" :class="['node', n.nodeType, { selected: selected === n.id, linking: linking === n.id, problem: problems.some(x => x.nodeId === n.id) }]" @mousedown="onDown(n, $event)" @click="selected = n.id">
                <rect width="150" height="60" rx="14" />
                <text x="12" y="24" font-size="11" class="kind">{{ n.nodeType === 'item' ? t(`prog.itemType.${n.itemType}`) : '' }}</text>
                <text x="12" y="44" font-size="13" font-weight="800">{{ nodeTitle(n).slice(0, 20) }}</text>
                <circle cx="150" cy="30" r="8" class="port" @click.stop="startLink(n.id)" />
              </g>
            </svg>
            <p class="sub">{{ t('prog.canvasHint') }} <template v-if="linking">· {{ t('prog.linkingFrom') }}</template></p>
            <div class="row"><span class="sub">{{ t('prog.newEdgeCond') }}:</span><select v-model="newEdge.condition" class="field"><option v-for="c in ['always', 'passed', 'failed', 'score_gte']" :key="c" :value="c">{{ t(`prog.cond.${c}`) }}</option></select><input v-if="newEdge.condition === 'score_gte'" v-model.number="newEdge.value" class="field short" type="number" min="0" max="100"></div>
          </div>

          <!-- Панель выбранного узла (граф) -->
          <div v-if="p.mode === 'graph' && selectedNode" class="panel">
            <h3>{{ nodeTitle(selectedNode) }}</h3>
            <input :value="selectedNode.titleOverride ?? ''" class="field" :placeholder="t('prog.titleOverride')" @change="patchNode(selectedNode, { titleOverride: ($event.target as HTMLInputElement).value || null })">
            <div class="row">
              <label class="check"><input type="checkbox" :checked="selectedNode.isRequired" @change="patchNode(selectedNode, { isRequired: ($event.target as HTMLInputElement).checked })"> {{ t('prog.required') }}</label>
              <label class="sub">{{ t('prog.dueDays') }} <input :value="selectedNode.dueDays ?? ''" class="field short" type="number" min="1" @change="patchNode(selectedNode, { dueDays: Number(($event.target as HTMLInputElement).value) || null })"></label>
              <button class="chip danger" @click="removeNode(selectedNode); selected = null">{{ t('prog.removeBlock') }}</button>
            </div>
          </div>

          <div class="row addrow">
            <select v-model="add.id" class="field grow" data-testid="prog-add-select"><option value="">{{ t('prog.pickContent') }}</option><option v-for="c in content" :key="c.id" :value="c.id">{{ t(`prog.itemType.${c.type}`) }} · {{ c.title }}</option></select>
            <input v-model="add.title" class="field" :placeholder="t('prog.titleOverride')">
            <button class="chip" :disabled="!add.id" data-testid="prog-add" @click="addNode">+ {{ t('prog.addItem') }}</button>
          </div>
        </section>

        <!-- ПАРАМЕТРИ ТРАЄКТОРІЇ (как в эталоне) -->
        <aside class="side">
          <h2>{{ t('prog.params') }}</h2>
          <input v-model="settings.title" class="field" :placeholder="t('prog.titlePh')">
          <textarea v-model="settings.description" class="field" rows="2" :placeholder="t('prog.descPh')" />
          <input v-model="settings.tags" class="field" :placeholder="t('prog.tagsPh')">
          <label class="sub">{{ t('course.code') }} <input v-model="settings.code" class="field short" maxlength="40"></label>
          <label class="sub">{{ t('course.workload') }} <input v-model="settings.workload" class="field" maxlength="200"></label>
          <label class="sub">{{ t('prog.dueDaysTotal') }} <input v-model.number="settings.dueDays" class="field short" type="number" min="1"></label>
          <label class="sub">{{ t('prog.validity') }} <input v-model.number="settings.validityMonths" class="field short" type="number" min="1" max="120"></label>
          <label class="check"><input v-model="settings.noAssignAfterFinish" type="checkbox"> {{ t('prog.noAssignAfterFinish') }}</label>
          <label class="check"><input v-model="settings.countPriorResults" type="checkbox"> {{ t('prog.countPrior') }}</label>
          <b class="sub">{{ t('prog.assignMode') }}</b>
          <label v-for="m in ['manual', 'catalog_free', 'catalog_request', 'automation']" :key="m" class="check"><input v-model="settings.assignmentMode" type="checkbox" :value="m"> {{ t(`prog.assign.${m}`) }}</label>
          <template v-if="settings.assignmentMode.includes('automation')">
            <select v-model="settings.automationRuleId" class="field" :disabled="!hasScope('program.link_rule')"><option value="">{{ t('prog.pickRule') }}</option><option v-for="r in rules" :key="r.id" :value="r.id">{{ r.name }}</option></select>
            <NuxtLink to="/admin/rules" class="link">{{ t('prog.createRule') }}</NuxtLink>
          </template>
          <button class="primary" @click="saveSettings">{{ t('common.save') }}</button>
          <p class="sub">{{ t('prog.updated') }}: {{ formatDateTime(new Date(p.updatedAt), { dateStyle: 'short', timeStyle: 'short' }) }}</p>
          <NuxtLink :to="`/admin/programs/${p.id}/report`" class="link">{{ t('prog.report') }} →</NuxtLink>
        </aside>
      </div>
    </template>
  </div>
</template>
<style scoped>
.back { color: var(--color-ink-muted); text-decoration: none; font-weight: 700; }
.head { display: flex; justify-content: space-between; align-items: center; gap: var(--space-2); margin: var(--space-2) 0; }
h1 { margin: 0; font-weight: 900; }
h2, h3 { margin: 0; font-weight: 800; }
.layout { display: grid; grid-template-columns: 1fr 300px; gap: var(--space-3); }
@media (max-width: 900px) { .layout { grid-template-columns: 1fr; } }
.main, .side { background: var(--color-bg-soft); border-radius: var(--radius-l); padding: var(--space-4); display: grid; gap: var(--space-3); align-content: start; }
.row { display: flex; gap: var(--space-2); align-items: center; flex-wrap: wrap; }
.spacer { flex: 1; }
.problems { margin: 0; padding-left: var(--space-4); display: grid; gap: 2px; font-size: var(--font-size-body-s); }
.problems .bad { color: var(--color-coral-ink); }
.problems .warn { color: var(--color-sun-ink); }
.linear { list-style: none; margin: 0; padding: 0; display: grid; gap: var(--space-2); }
.item { display: flex; gap: var(--space-2); background: var(--color-bg); border-radius: var(--radius-m); padding: var(--space-2); }
.num { width: 28px; height: 28px; border-radius: 14px; background: var(--color-sun); color: var(--color-sun-ink); display: grid; place-items: center; font-weight: 900; flex: none; }
.body { display: grid; gap: var(--space-1); flex: 1; }
.canvas-wrap { display: grid; gap: var(--space-2); }
.canvas { width: 100%; aspect-ratio: 1000 / 520; background: var(--color-bg); border-radius: var(--radius-m); user-select: none; }
.node rect { fill: var(--color-bg-soft); stroke: var(--color-bg-line); stroke-width: 2; cursor: grab; }
.node.start rect, .node.finish rect { fill: var(--color-ink); }
.node.start text, .node.finish text { fill: var(--color-bg); }
.node.selected rect { stroke: var(--color-ink); }
.node.linking rect { stroke: var(--color-sun); stroke-width: 3; }
.node.problem rect { stroke: var(--color-coral); stroke-width: 3; }
.node text { fill: var(--color-ink); pointer-events: none; }
.node .kind { fill: var(--color-ink-muted); }
.port { fill: var(--color-teal); cursor: crosshair; }
.edge { cursor: pointer; }
.panel { background: var(--color-bg); border-radius: var(--radius-m); padding: var(--space-3); display: grid; gap: var(--space-2); }
.addrow { border-top: 1px solid var(--color-bg-line); padding-top: var(--space-3); }
.field, select, textarea { font: inherit; border: 1px solid var(--color-bg-line); border-radius: var(--radius-s); padding: var(--space-2) var(--space-3); background: var(--color-bg); color: var(--color-ink); }
.short { width: 70px; }
.grow { flex: 1; min-width: 160px; }
.check { display: flex; gap: var(--space-1); align-items: center; font-size: var(--font-size-body-s); }
.chip { font: inherit; font-size: var(--font-size-body-s); font-weight: 700; border: 1px solid var(--color-bg-line); background: transparent; color: var(--color-ink-muted); border-radius: var(--radius-pill); padding: var(--space-1) var(--space-3); cursor: pointer; }
.chip.danger { color: var(--color-coral-ink); }
.chip:disabled { opacity: 0.5; }
.primary { font: inherit; font-weight: 800; border: none; background: var(--color-sun); color: var(--color-ink); border-radius: var(--radius-pill); padding: var(--space-2) var(--space-4); cursor: pointer; }
.primary:disabled { opacity: 0.5; }
.badge { font-size: var(--font-size-body-s); font-weight: 700; border-radius: var(--radius-pill); padding: 2px var(--space-3); background: var(--color-bg-line-soft); }
.badge.published { background: var(--color-teal); color: var(--color-teal-deep); }
.link { color: var(--color-ink); font-weight: 700; }
.sub { font-size: var(--font-size-body-s); color: var(--color-ink-faint); margin: 0; }
.error { color: var(--color-coral-ink); }
.notice { color: var(--color-teal-ink); }
</style>
