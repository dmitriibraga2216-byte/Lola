<script setup lang="ts">
import { CONTENT_TYPES } from '#shared/enums'

/**
 * Редактор траектории по мокапу Trajectory: палитра блоков над полотном, полотно с блоками и связями,
 * панель выбранного блока, «Перевірити» + «N блоків · M звʼязків · помилок немає», справа — режим призначення.
 * Условия живут в узлах (docs/17 §14.3); у «Розгалуження» — условия на его исходящих связях (Г-17.1).
 * Без drag-n-drop: положение — «Автовирівнювання» по шарам от Start либо стрелками с клавиатуры.
 */
definePageMeta({ layout: 'admin', middleware: 'admin-scope', requiredScope: 'program.manage' })
const { t } = useI18n()
const { api } = useApi()
const { hasScope } = useAuth()
const route = useRoute()
const id = route.params.id as string

type Kind = 'start' | 'finish' | 'task' | 'and' | 'or' | 'delay' | 'stop_delay' | 'branch' | 'mentor'
interface Node { id: string, kind: Kind, title: string | null, contentType: string | null, contentId: string | null, contentTitle: string | null, days: number | null, mentorId: string | null, params: Record<string, unknown>, x: number, y: number }
interface Cond { op: 'passed' | 'failed' | 'score_gte' | 'else', value?: number }
interface Edge { id?: string, fromNodeId: string, toNodeId: string, condition: Cond | null, sort: number }
interface Problem { code: string, nodeId?: string, edgeId?: string, message: string }
interface Traj { id: string, title: string, status: string, assignMode: string, automationRuleId: string | null, stopAssignAfterFinish: boolean, tags: string[], updatedAt: string, updatedByName: string | null, rule: { id: string, name: string } | null, stats: { people: number, done: number, inProgress: number, requested: number }, nodes: Node[], edges: Edge[] }

const traj = ref<Traj | null>(null)
const nodes = ref<Node[]>([])
const edges = ref<Edge[]>([])
const problems = ref<Problem[]>([])
const checked = ref(false)
const selected = ref<string | null>(null)
const linkFrom = ref<string | null>(null)
const error = ref('')
const notice = ref('')
const dirty = ref(false)
const saving = ref(false)
const rules = ref<{ id: string, name: string }[]>([])
const contents = ref<{ id: string, title: string }[]>([])
const people = ref<{ id: string, fullName: string }[]>([])
const contentType = ref<string>('course')
const assignOpen = ref(false)
const pickedUsers = ref<string[]>([])
const canvasRef = ref<HTMLElement | null>(null)

const NODE_W: Record<Kind, number> = { start: 104, finish: 168, task: 160, and: 104, or: 104, delay: 168, stop_delay: 168, branch: 160, mentor: 160 }
const NODE_H = 56
const PALETTE: { kind: Kind, key: string }[] = [
  { kind: 'task', key: 'task' }, { kind: 'and', key: 'and' }, { kind: 'or', key: 'or' }, { kind: 'delay', key: 'delay' },
  { kind: 'stop_delay', key: 'stop_delay' }, { kind: 'branch', key: 'branch' }, { kind: 'mentor', key: 'mentor' },
]
const published = computed(() => traj.value?.status === 'published')
const selNode = computed(() => nodes.value.find(n => n.id === selected.value) ?? null)
const outgoing = computed(() => edges.value.filter(e => e.fromNodeId === selected.value))
const incoming = computed(() => edges.value.filter(e => e.toNodeId === selected.value))
const problemNodes = computed(() => new Set(problems.value.map(p => p.nodeId).filter(Boolean)))
const bounds = computed(() => ({ w: Math.max(760, ...nodes.value.map(n => n.x + NODE_W[n.kind] + 40)), h: Math.max(420, ...nodes.value.map(n => n.y + NODE_H + 40)) }))

async function load() {
  try {
    traj.value = await api<Traj>(`/trajectories/${id}`)
    nodes.value = traj.value.nodes.map(n => ({ ...n, params: n.params ?? {} }))
    edges.value = traj.value.edges
    dirty.value = false
    if (hasScope('program.link_rule')) rules.value = await api('/automation-rules')
  }
  catch (err) { error.value = apiErrorOf(err).message }
}
onMounted(load)
watch(contentType, async (ct) => { try { contents.value = await api('/tasks/content', { query: { type: ct } }) } catch { contents.value = [] } }, { immediate: true })

function nodeLabel(n: Node) {
  if (n.kind === 'task') return n.title || n.contentTitle || t('traj.kind.task')
  if (n.kind === 'start') return 'Start'
  if (n.kind === 'finish') return 'Finish'
  return n.title || t(`traj.kind.${n.kind}`)
}
function nodeSub(n: Node) {
  switch (n.kind) {
    case 'start': return t('traj.startSub')
    case 'finish': return t('traj.finishSub')
    case 'task': return n.contentType ? t(`contentType.${n.contentType}`) : t('traj.pickContent')
    case 'and': return t('traj.andSub')
    case 'or': return t('traj.orSub')
    case 'delay': return t('traj.delaySub', { n: n.days ?? '?' })
    case 'stop_delay': return t('traj.stopDelaySub', { n: n.days ?? '?' })
    case 'branch': return t('traj.branchSub')
    case 'mentor': return t('traj.mentorSub')
  }
}
function addNode(kind: Kind) {
  if (published.value) return
  const y = 40 + (nodes.value.length % 5) * 90, x = 200 + Math.floor(nodes.value.length / 5) * 220
  const n: Node = { id: `tmp:${Date.now()}:${Math.random().toString(36).slice(2, 6)}`, kind, title: kind === 'task' ? null : t(`traj.kind.${kind}`), contentType: kind === 'task' ? contentType.value : null, contentId: null, contentTitle: null, days: kind === 'delay' || kind === 'stop_delay' ? 3 : null, mentorId: null, params: {}, x, y }
  nodes.value.push(n); selected.value = n.id; dirty.value = true
}
function removeNode(n: Node) {
  if (published.value || n.kind === 'start' || n.kind === 'finish') return
  nodes.value = nodes.value.filter(x => x.id !== n.id)
  edges.value = edges.value.filter(e => e.fromNodeId !== n.id && e.toNodeId !== n.id)
  selected.value = null; dirty.value = true
}
function selectNode(n: Node) {
  if (linkFrom.value && linkFrom.value !== n.id) {
    if (!edges.value.some(e => e.fromNodeId === linkFrom.value && e.toNodeId === n.id)) {
      const from = nodes.value.find(x => x.id === linkFrom.value)
      edges.value.push({ fromNodeId: linkFrom.value, toNodeId: n.id, condition: from?.kind === 'branch' ? { op: 'else' } : null, sort: edges.value.filter(e => e.fromNodeId === linkFrom.value).length })
      dirty.value = true
    }
    linkFrom.value = null
    return
  }
  selected.value = n.id
}
function removeEdge(e: Edge) { edges.value = edges.value.filter(x => x !== e); dirty.value = true }
function moveNode(n: Node, dx: number, dy: number) { n.x = Math.max(0, n.x + dx); n.y = Math.max(0, n.y + dy); dirty.value = true }
function onNodeKey(ev: KeyboardEvent, n: Node) {
  const step = ev.shiftKey ? 40 : 10
  if (ev.key === 'ArrowLeft') { moveNode(n, -step, 0); ev.preventDefault() }
  else if (ev.key === 'ArrowRight') { moveNode(n, step, 0); ev.preventDefault() }
  else if (ev.key === 'ArrowUp') { moveNode(n, 0, -step); ev.preventDefault() }
  else if (ev.key === 'ArrowDown') { moveNode(n, 0, step); ev.preventDefault() }
  else if (ev.key === 'Delete' || ev.key === 'Backspace') { removeNode(n); ev.preventDefault() }
  else if (ev.key === 'Enter' || ev.key === ' ') { selectNode(n); ev.preventDefault() }
}
/** «Автовирівнювання»: шары BFS от Start слева направо, внутри шара — сверху вниз. */
function autoLayout() {
  const start = nodes.value.find(n => n.kind === 'start')
  const layer = new Map<string, number>()
  const q: string[] = start ? [start.id] : []
  if (start) layer.set(start.id, 0)
  while (q.length) {
    const cur = q.shift()!
    for (const e of edges.value.filter(x => x.fromNodeId === cur)) {
      if (!layer.has(e.toNodeId)) { layer.set(e.toNodeId, (layer.get(cur) ?? 0) + 1); q.push(e.toNodeId) }
    }
  }
  const finish = nodes.value.find(n => n.kind === 'finish')
  const maxL = Math.max(0, ...[...layer.values()])
  if (finish) layer.set(finish.id, maxL + (layer.has(finish.id) ? 0 : 1))
  const rows = new Map<number, number>()
  for (const n of nodes.value) {
    const l = layer.get(n.id) ?? maxL + 2
    const r = rows.get(l) ?? 0
    n.x = 16 + l * 220; n.y = 24 + r * 96
    rows.set(l, r + 1)
  }
  dirty.value = true
}
function edgePath(e: Edge) {
  const a = nodes.value.find(n => n.id === e.fromNodeId), b = nodes.value.find(n => n.id === e.toNodeId)
  if (!a || !b) return ''
  const x1 = a.x + NODE_W[a.kind], y1 = a.y + NODE_H / 2, x2 = b.x, y2 = b.y + NODE_H / 2
  const mx = (x1 + x2) / 2
  return `M ${x1} ${y1} L ${mx} ${y1} L ${mx} ${y2} L ${x2 - 6} ${y2}`
}
function edgeLabel(e: Edge) {
  if (!e.condition) return ''
  if (e.condition.op === 'score_gte') return `≥ ${e.condition.value ?? 0}`
  return t(`traj.cond.${e.condition.op}`)
}
function edgeMid(e: Edge) {
  const a = nodes.value.find(n => n.id === e.fromNodeId), b = nodes.value.find(n => n.id === e.toNodeId)
  if (!a || !b) return { x: 0, y: 0 }
  return { x: (a.x + NODE_W[a.kind] + b.x) / 2, y: b.y + NODE_H / 2 - 6 }
}

function graphBody() {
  return {
    nodes: nodes.value.map((n) => {
      const base = { id: n.id.startsWith('tmp:') ? undefined : n.id, tmpId: n.id.startsWith('tmp:') ? n.id : undefined, kind: n.kind, x: Math.round(n.x), y: Math.round(n.y) }
      if (n.kind === 'task') return { ...base, title: n.title || null, contentType: n.contentType, contentId: n.contentId, params: n.params }
      if (n.kind === 'delay' || n.kind === 'stop_delay') return { ...base, title: n.title ?? '', days: n.days ?? 0 }
      if (n.kind === 'mentor') return { ...base, title: n.title ?? '', mentorId: n.mentorId }
      if (n.kind === 'start' || n.kind === 'finish') return base
      return { ...base, title: n.title ?? '' }
    }),
    edges: edges.value.map((e, i) => ({ fromNodeId: e.fromNodeId, toNodeId: e.toNodeId, condition: e.condition, sort: i })),
  }
}
async function save(): Promise<boolean> {
  error.value = ''; notice.value = ''; saving.value = true
  try {
    const r = await api<{ nodes: Node[], edges: Edge[], problems: Problem[], ids: Record<string, string> }>(`/trajectories/${id}/graph`, { method: 'PUT', body: graphBody() })
    const titles = new Map(nodes.value.map(n => [n.id, n.contentTitle]))
    if (selected.value && r.ids[selected.value]) selected.value = r.ids[selected.value]!
    nodes.value = r.nodes.map(n => ({ ...n, params: n.params ?? {}, contentTitle: (traj.value?.nodes.find(x => x.id === n.id)?.contentTitle) ?? titles.get(n.id) ?? contents.value.find(c => c.id === n.contentId)?.title ?? null }))
    edges.value = r.edges
    problems.value = r.problems; checked.value = true
    dirty.value = false
    notice.value = t('common.saved')
    return true
  }
  catch (err) { error.value = apiErrorOf(err).message; return false }
  finally { saving.value = false }
}
async function check() {
  if (dirty.value && !published.value) { if (!await save()) return }
  try { const r = await api<{ problems: Problem[] }>(`/trajectories/${id}/validate`, { method: 'POST', body: {} }); problems.value = r.problems; checked.value = true }
  catch (err) { error.value = apiErrorOf(err).message }
}
async function publish() {
  if (dirty.value && !await save()) return
  error.value = ''
  try {
    await api(`/trajectories/${id}/publish`, { method: 'POST', body: {} })
    notice.value = t('traj.published'); await load()
  }
  catch (err) {
    const e = apiErrorOf(err) as { message: string, details?: { problems?: Problem[] } }
    if (e.details?.problems) { problems.value = e.details.problems; checked.value = true }
    error.value = e.message
  }
}
async function patch(body: Record<string, unknown>) {
  error.value = ''
  try { traj.value = { ...traj.value!, ...(await api<Traj>(`/trajectories/${id}`, { method: 'PATCH', body })) }; notice.value = t('common.saved'); await load() }
  catch (err) { error.value = apiErrorOf(err).message }
}
async function duplicate() {
  try { const c = await api<{ id: string }>(`/trajectories/${id}/duplicate`, { method: 'POST', body: {} }); await navigateTo(`/admin/trajectories/${c.id}`) }
  catch (err) { error.value = apiErrorOf(err).message }
}
async function openAssign() {
  assignOpen.value = true
  try { people.value = await api('/people', { query: { limit: 100 } }) } catch (err) { error.value = apiErrorOf(err).message }
}
async function assign() {
  error.value = ''
  try {
    const r = await api<{ added: number, skipped: unknown[] }>(`/trajectories/${id}/audience`, { method: 'POST', body: { userIds: pickedUsers.value } })
    notice.value = t('traj.assigned', { n: r.added }); assignOpen.value = false; pickedUsers.value = []; await load()
  }
  catch (err) { error.value = apiErrorOf(err).message }
}
function setCondition(e: Edge, op: Cond['op']) { e.condition = op === 'score_gte' ? { op, value: e.condition?.value ?? 80 } : { op }; dirty.value = true }
const nodeName = (nid: string) => { const n = nodes.value.find(x => x.id === nid); return n ? nodeLabel(n) : '?' }
const ASSIGN_MODES = ['manual', 'catalog_free', 'catalog_request', 'automation'] as const
</script>

<template>
  <div v-if="traj">
    <PageHeader :title="traj.title" :crumbs="[{ label: t('admin.section.learning') }, { label: t('traj.title'), to: '/admin/trajectories' }]">
      <template #actions>
        <button v-if="!published" class="btn ghost" :disabled="!dirty || saving" @click="save">{{ t('common.save') }}</button>
        <NuxtLink :to="`/admin/trajectories/${id}/people`" class="btn ghost">{{ t('traj.people', { n: traj.stats.people }) }}</NuxtLink>
        <button v-if="published" class="btn ghost" @click="openAssign">{{ t('traj.assign') }}</button>
        <button v-if="published" class="btn ghost" @click="duplicate">{{ t('traj.duplicate') }}</button>
        <button v-if="!published && hasScope('program.publish')" class="btn primary" data-testid="traj-publish" @click="publish">{{ t('traj.publish') }}</button>
      </template>
    </PageHeader>
    <p v-if="error" class="error-text" role="alert">{{ error }}</p>
    <p v-if="notice" class="note teal">{{ notice }}</p>
    <p v-if="published" class="note sun">{{ t('traj.publishedHint') }}</p>

    <div class="layout">
      <section class="editor">
        <div class="chips palette" role="toolbar" :aria-label="t('traj.palette')">
          <button v-for="p in PALETTE" :key="p.kind" class="chip outline" type="button" :disabled="published" @click="addNode(p.kind)">+ {{ t(`traj.kind.${p.kind}`) }}</button>
          <button class="chip" type="button" @click="autoLayout">{{ t('traj.autoLayout') }}</button>
        </div>

        <div ref="canvasRef" class="canvas" :style="{ minHeight: `${bounds.h}px` }">
          <div class="canvas-inner" :style="{ width: `${bounds.w}px`, height: `${bounds.h}px` }">
            <svg class="wires" :width="bounds.w" :height="bounds.h" aria-hidden="true">
              <defs><marker id="arrow" markerWidth="8" markerHeight="8" refX="7" refY="4" orient="auto"><path d="M0,0 L8,4 L0,8 z" class="arrow" /></marker></defs>
              <g v-for="(e, i) in edges" :key="i">
                <path :d="edgePath(e)" class="wire" :class="{ sel: e.fromNodeId === selected || e.toNodeId === selected }" marker-end="url(#arrow)" />
                <text v-if="e.condition" :x="edgeMid(e).x" :y="edgeMid(e).y" class="wire-label" text-anchor="middle">{{ edgeLabel(e) }}</text>
              </g>
            </svg>
            <div
              v-for="n in nodes" :key="n.id"
              :class="['node', n.kind, { sel: selected === n.id, bad: problemNodes.has(n.id), link: linkFrom === n.id }]"
              :style="{ left: `${n.x}px`, top: `${n.y}px`, width: `${NODE_W[n.kind]}px` }"
              role="button" tabindex="0" :aria-pressed="selected === n.id" :aria-label="`${nodeLabel(n)} — ${nodeSub(n)}`"
              @click="selectNode(n)" @keydown="onNodeKey($event, n)"
            >
              <div class="node-title">{{ nodeLabel(n) }}</div>
              <div class="node-sub">{{ nodeSub(n) }}</div>
            </div>
          </div>
        </div>

        <div class="check-row">
          <button class="btn ghost" type="button" data-testid="traj-check" @click="check">{{ t('traj.check') }}</button>
          <span class="muted">
            {{ t('traj.blocksN', { n: nodes.length }) }} · {{ t('traj.edgesN', { n: edges.length }) }}
            <template v-if="checked"> · <span :class="problems.length ? 'coral' : 'teal'">{{ problems.length ? t('traj.problemsN', { n: problems.length }) : t('traj.noProblems') }}</span></template>
          </span>
        </div>
        <ul v-if="problems.length" class="problems" aria-live="polite">
          <li v-for="(p, i) in problems" :key="i"><button class="link-btn" type="button" @click="selected = p.nodeId ?? null">{{ p.message }}</button></li>
        </ul>
      </section>

      <aside class="side">
        <div v-if="selNode" class="card">
          <h2 class="panel-title">{{ t(`traj.kind.${selNode.kind}`) }}</h2>
          <template v-if="selNode.kind === 'task'">
            <label class="label">{{ t('traj.contentType') }}</label>
            <select v-model="contentType" class="field" :disabled="published" @change="selNode.contentType = contentType; selNode.contentId = null; dirty = true">
              <option v-for="ct in CONTENT_TYPES" :key="ct" :value="ct">{{ t(`contentType.${ct}`) }}</option>
            </select>
            <label class="label">{{ t('traj.content') }}</label>
            <select v-model="selNode.contentId" class="field" :disabled="published" @change="selNode.contentType = contentType; selNode.contentTitle = contents.find(c => c.id === selNode!.contentId)?.title ?? null; dirty = true">
              <option :value="null">—</option>
              <option v-for="c in contents" :key="c.id" :value="c.id">{{ c.title }}</option>
            </select>
            <label class="label">{{ t('traj.titleOverride') }}</label>
            <input v-model="selNode.title" class="field" :disabled="published" @input="dirty = true">
            <label class="label">{{ t('traj.dueDays') }}</label>
            <input :value="selNode.params.dueDays ?? ''" type="number" min="1" max="365" class="field" :disabled="published" @input="selNode.params = { ...selNode.params, dueDays: ($event.target as HTMLInputElement).value ? Number(($event.target as HTMLInputElement).value) : undefined }; dirty = true">
            <label v-if="selNode.contentType === 'test' || selNode.contentType === 'complex_test' || selNode.contentType === 'course'" class="label">{{ t('traj.passScore') }}</label>
            <input v-if="selNode.contentType === 'test' || selNode.contentType === 'complex_test' || selNode.contentType === 'course'" :value="selNode.params.passScore ?? ''" type="number" min="0" max="100" class="field" :disabled="published" @input="selNode.params = { ...selNode.params, passScore: ($event.target as HTMLInputElement).value ? Number(($event.target as HTMLInputElement).value) : undefined }; dirty = true">
          </template>
          <template v-else-if="selNode.kind !== 'start' && selNode.kind !== 'finish'">
            <label class="label" for="node-title">{{ t('traj.nodeTitle') }}</label>
            <input id="node-title" v-model="selNode.title" class="field" :disabled="published" required @input="dirty = true">
            <template v-if="selNode.kind === 'delay' || selNode.kind === 'stop_delay'">
              <label class="label" for="node-days">{{ selNode.kind === 'delay' ? t('traj.delayDays') : t('traj.stopDelayDays') }}</label>
              <input id="node-days" v-model.number="selNode.days" type="number" min="1" max="365" class="field" :disabled="published" @input="dirty = true">
            </template>
            <template v-if="selNode.kind === 'mentor'">
              <p class="help">{{ t('traj.mentorHelp') }}</p>
            </template>
            <p class="help">{{ t(`traj.help.${selNode.kind}`) }}</p>
          </template>
          <p v-else class="help">{{ t(`traj.help.${selNode.kind}`) }}</p>

          <h3 class="sub-title">{{ t('traj.links') }}</h3>
          <ul class="links">
            <li v-for="e in incoming" :key="`in-${e.fromNodeId}`"><span class="muted">← {{ nodeName(e.fromNodeId) }}</span> <button v-if="!published" class="chip" type="button" @click="removeEdge(e)">×</button></li>
            <li v-for="e in outgoing" :key="`out-${e.toNodeId}`">
              <span>→ {{ nodeName(e.toNodeId) }}</span>
              <select v-if="selNode.kind === 'branch'" class="field small" :value="e.condition?.op ?? 'else'" :disabled="published" :aria-label="t('traj.condition')" @change="setCondition(e, ($event.target as HTMLSelectElement).value as Cond['op'])">
                <option value="passed">{{ t('traj.cond.passed') }}</option><option value="failed">{{ t('traj.cond.failed') }}</option><option value="score_gte">{{ t('traj.cond.score_gte') }}</option><option value="else">{{ t('traj.cond.else') }}</option>
              </select>
              <input v-if="selNode.kind === 'branch' && e.condition?.op === 'score_gte'" v-model.number="e.condition.value" type="number" min="0" max="100" class="field small" :disabled="published" :aria-label="t('traj.scoreValue')" @input="dirty = true">
              <button v-if="!published" class="chip" type="button" @click="removeEdge(e)">×</button>
            </li>
          </ul>
          <div v-if="!published && selNode.kind !== 'finish'" class="row">
            <button class="btn ghost small" type="button" :aria-pressed="linkFrom === selNode.id" @click="linkFrom = linkFrom === selNode.id ? null : selNode.id">{{ linkFrom === selNode.id ? t('traj.linkPick') : t('traj.linkAdd') }}</button>
            <button v-if="selNode.kind !== 'start'" class="btn danger small" type="button" @click="removeNode(selNode)">{{ t('traj.deleteBlock') }}</button>
          </div>
        </div>
        <div v-else class="card"><p class="help">{{ t('traj.selectHint') }}</p></div>

        <div class="card">
          <h2 class="panel-title">{{ t('traj.assignModeTitle') }}</h2>
          <label v-for="m in ASSIGN_MODES" :key="m" class="radio">
            <input type="radio" name="assign-mode" :value="m" :checked="traj.assignMode === m" :disabled="m === 'automation' && !hasScope('program.link_rule')" @change="patch({ assignMode: m })">
            <span>{{ t(`traj.assignMode.${m}`) }}</span>
          </label>
          <template v-if="traj.assignMode === 'automation'">
            <label class="label" for="traj-rule">{{ t('traj.rule') }}</label>
            <select id="traj-rule" class="field" :value="traj.automationRuleId ?? ''" :disabled="!hasScope('program.link_rule')" @change="patch({ automationRuleId: ($event.target as HTMLSelectElement).value || null })">
              <option value="">—</option>
              <option v-for="r in rules" :key="r.id" :value="r.id">{{ r.name }}</option>
            </select>
            <p class="help">{{ t('traj.ruleHint') }} <NuxtLink to="/admin/rules/new" class="link">{{ t('traj.ruleCreate') }}</NuxtLink></p>
          </template>
          <label class="toggle">
            <input type="checkbox" :checked="traj.stopAssignAfterFinish" @change="patch({ stopAssignAfterFinish: ($event.target as HTMLInputElement).checked })">
            <span>{{ t('traj.stopAfterFinish') }}</span>
          </label>
          <p class="help">{{ t('traj.updatedBy', { date: new Date(traj.updatedAt).toLocaleDateString('uk-UA'), name: traj.updatedByName ?? '—' }) }}</p>
        </div>

        <div class="card">
          <h2 class="panel-title">{{ t('traj.nodesTitle') }}</h2>
          <p class="help">{{ t('traj.nodesHint') }}</p>
        </div>
      </aside>
    </div>

    <div v-if="assignOpen" class="modal-back" @click.self="assignOpen = false">
      <div class="modal card" role="dialog" aria-modal="true" :aria-label="t('traj.assign')">
        <h2 class="panel-title">{{ t('traj.assign') }}</h2>
        <select v-model="pickedUsers" multiple class="field people" size="10">
          <option v-for="p in people" :key="p.id" :value="p.id">{{ p.fullName }}</option>
        </select>
        <div class="row">
          <button class="btn primary" :disabled="!pickedUsers.length" @click="assign">{{ t('traj.assignN', { n: pickedUsers.length }) }}</button>
          <button class="btn ghost" @click="assignOpen = false">{{ t('common.cancel') }}</button>
        </div>
      </div>
    </div>
  </div>
</template>

<style scoped>
.layout { display: grid; grid-template-columns: minmax(0, 1fr) 280px; gap: var(--space-4); }
.editor { min-width: 0; }
.palette { margin-bottom: var(--space-3); }
.canvas { position: relative; background: var(--color-bg-soft); border: 1px solid var(--color-bg-line); border-radius: var(--radius-l); overflow: auto; }
.canvas-inner { position: relative; }
.wires { position: absolute; inset: 0; pointer-events: none; }
.wire { fill: none; stroke: var(--color-ink-muted); stroke-width: 2; }
.wire.sel { stroke: var(--color-ink); stroke-width: 3; }
.arrow { fill: var(--color-ink-muted); }
.wire-label { font-size: 11px; font-weight: 800; fill: var(--color-ink); }
.node { position: absolute; box-sizing: border-box; height: 56px; padding: var(--space-2) var(--space-3); border: 2px solid var(--color-ink); border-radius: var(--radius-s); background: var(--color-bg-soft); color: var(--color-ink); cursor: pointer; overflow: hidden; }
.node.start { background: var(--color-teal); }
.node.finish { background: var(--color-ink); color: var(--color-bg); }
.node.and, .node.or { background: var(--color-sun); }
.node.delay { background: var(--color-sun-soft); }
.node.stop_delay { background: var(--color-coral-soft); }
.node.branch { background: var(--color-bg); }
.node.mentor { background: var(--color-teal-soft); }
.node.sel { outline: 3px solid var(--color-teal); outline-offset: 2px; }
.node.bad { border-color: var(--color-coral); box-shadow: inset 0 0 0 2px var(--color-coral); }
.node.link { border-style: dashed; }
.node-title { font-size: 13px; font-weight: 900; line-height: 17px; white-space: nowrap; overflow: hidden; text-overflow: ellipsis; }
.node-sub { font-size: 11px; font-weight: 700; opacity: 0.8; margin-top: 2px; white-space: nowrap; overflow: hidden; text-overflow: ellipsis; }
.check-row { display: flex; gap: var(--space-3); align-items: center; margin-top: var(--space-3); flex-wrap: wrap; }
.teal { color: var(--color-teal-ink); font-weight: 700; }
.coral { color: var(--color-coral-ink); font-weight: 700; }
.problems { margin: var(--space-2) 0 0; padding-left: var(--space-4); color: var(--color-coral-ink); font-weight: 700; font-size: var(--font-size-body-s); }
.link-btn { font: inherit; color: inherit; background: none; border: none; padding: 0; text-align: left; cursor: pointer; text-decoration: underline; }
.side { display: grid; gap: var(--space-3); align-content: start; }
.sub-title { margin: var(--space-3) 0 var(--space-1); font-size: var(--font-size-body-s); font-weight: 900; text-transform: uppercase; letter-spacing: 0.04em; }
.links { list-style: none; margin: 0; padding: 0; display: grid; gap: var(--space-1); font-size: var(--font-size-body-s); }
.links li { display: flex; gap: var(--space-2); align-items: center; flex-wrap: wrap; }
.field.small { width: auto; padding: var(--space-1) var(--space-2); font-size: var(--font-size-body-s); }
.row { display: flex; gap: var(--space-2); flex-wrap: wrap; margin-top: var(--space-3); }
.radio { display: flex; gap: var(--space-2); align-items: flex-start; font-weight: 600; margin-bottom: var(--space-2); cursor: pointer; }
.toggle { margin-top: var(--space-3); }
.label + .field, .field + .label { margin-top: var(--space-1); }
.label { margin-top: var(--space-2); }
.modal-back { position: fixed; inset: 0; background: rgb(12 15 20 / 0.4); display: grid; place-items: center; z-index: 20; padding: var(--space-4); }
.modal { width: min(480px, 100%); display: grid; gap: var(--space-3); }
.people { min-height: 240px; }
@media (max-width: 900px) { .layout { grid-template-columns: 1fr; } }
</style>
