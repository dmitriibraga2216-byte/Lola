<script setup lang="ts">
import type { OfflineRun } from '~/composables/useOfflineRuns'

definePageMeta({ layout: 'learner', middleware: 'admin-scope', requiredScope: 'checklist.run' })
const { t } = useI18n()
const { api } = useApi()
const { me } = useAuth()
const { compressImage } = useMediaUpload()
const offline = useOfflineRuns()
const route = useRoute()
const router = useRouter()
interface Opt { value: number, label: string, color?: string }
interface Item { id: string, group?: string, text: string, scaleId: string, isCritical?: boolean, requiresPhoto?: boolean, hint?: string }
interface CL { id: string, title: string, items: Item[], scales: { id: string, options: Opt[], allowNa: boolean, passThreshold: string | null }[], subjectKind: string }
const cl = ref<CL | null>(null)
const run = ref<OfflineRun | null>(null)
const people = ref<{ id: string, fullName: string }[]>([])
const error = ref('')
const flagged = ref<string[]>([])
const stage = ref<'fill' | 'result'>('fill')
const result = ref<{ score: number, passed: boolean, criticalFailed: string[], failedItems: string[] } | null>(null)
const busy = ref(false)
const key = String(route.params.key)
const CACHE = `lola.checklist.${route.query.checklistId}`

onMounted(async () => {
  const checklistId = String(route.query.checklistId)
  try {
    cl.value = await api<CL>(`/checklists/${checklistId}`)
    try { localStorage.setItem(CACHE, JSON.stringify(cl.value)) } catch { /* ignore */ }
  } catch {
    try { cl.value = JSON.parse(localStorage.getItem(CACHE) || 'null') } catch { /* ignore */ }
    if (!cl.value) { error.value = t('cl.needOnlineFirst'); return }
  }
  run.value = offline.load(key) ?? { key, runId: null, checklistId, locationId: route.query.locationId ? String(route.query.locationId) : undefined, startedAt: new Date().toISOString(), answers: {}, actionPlan: [], pendingFinish: false }
  for (const it of cl.value.items) run.value.answers[it.id] ??= { value: null, comment: '', isNa: false, photos: [] }
  offline.save(run.value)
  try { people.value = (await api<{ id: string, fullName: string }[]>('/people?limit=100')).map(p => ({ id: p.id, fullName: p.fullName })) } catch { people.value = me.value ? [{ id: me.value.user.id, fullName: me.value.user.fullName }] : [] }
})
const groups = computed(() => { const m = new Map<string, Item[]>(); for (const it of cl.value?.items ?? []) { const g = it.group || ''; m.set(g, [...(m.get(g) ?? []), it]) } return [...m] })
const scaleOf = (it: Item) => cl.value?.scales.find(s => s.id === it.scaleId)
const done = computed(() => cl.value ? cl.value.items.filter(i => run.value?.answers[i.id]?.value != null || run.value?.answers[i.id]?.isNa).length : 0)
function set(id: string, patch: Partial<{ value: number | null, comment: string, isNa: boolean }>) {
  const a = run.value!.answers[id]!
  Object.assign(a, patch)
  if (patch.isNa) a.value = null
  if (patch.value != null) a.isNa = false
  offline.save(run.value!)
}
async function photo(id: string, e: Event) {
  const f = (e.target as HTMLInputElement).files?.[0]
  if (!f) return
  const blob = await compressImage(f)
  const dataUrl = await new Promise<string>((res) => { const r = new FileReader(); r.onload = () => res(String(r.result)); r.readAsDataURL(blob) })
  run.value!.answers[id]!.photos.push({ dataUrl })
  offline.save(run.value!)
}
function addAction() { run.value!.actionPlan.push({ id: crypto.randomUUID(), text: '', responsibleId: me.value?.user.id ?? '', dueAt: '', status: 'open' }); offline.save(run.value!) }
async function finish() {
  error.value = ''; flagged.value = []; busy.value = true
  run.value!.finishedAt = run.value!.finishedAt ?? new Date().toISOString()
  run.value!.pendingFinish = true
  offline.save(run.value!)
  try {
    if (!offline.online.value) { stage.value = 'result'; return }
    const r = await offline.push(run.value!)
    if (!r.ok) {
      error.value = r.message; flagged.value = r.itemIds ?? []
      run.value!.finishedAt = undefined
      if (r.code === 'checklist.action_plan_required') { stage.value = 'result'; if (!run.value!.actionPlan.length) addAction() }
      return
    }
    router.push('/learn/checklists')
  } catch (err) { error.value = apiErrorOf(err).message; run.value!.finishedAt = undefined } finally { busy.value = false }
}
// Локальный предрасчёт результата для экрана «после завершения» (сервер — источник истины)
const localScore = computed(() => {
  if (!cl.value || !run.value) return null
  let num = 0, den = 0
  const failed: string[] = []; const crit: string[] = []
  for (const it of cl.value.items) {
    const a = run.value.answers[it.id]; const s = scaleOf(it)
    if (!a || a.isNa || a.value == null) continue
    const max = Math.max(...(s?.options ?? [{ value: 1 }]).map(o => o.value), 1); const pass = s?.passThreshold != null ? Number(s.passThreshold) : max
    if (a.value < pass) { failed.push(it.id); if (it.isCritical) crit.push(it.id) }
    num += a.value; den += max
  }
  const pct = den ? Math.round((num / den) * 100) : 0
  return { score: crit.length ? 0 : pct, passed: !crit.length && pct >= 80, failedItems: failed, criticalFailed: crit }
})
const itemText = (id: string) => cl.value?.items.find(i => i.id === id)?.text ?? ''
</script>
<template>
  <div v-if="cl && run">
    <NuxtLink to="/learn/checklists" class="back">← {{ t('cl.title') }}</NuxtLink>
    <h1>{{ cl.title }}</h1>
    <p v-if="!offline.online.value" class="offline">{{ t('cl.offlineFill') }}</p>
    <p v-if="error" class="error">{{ error }}</p>

    <template v-if="stage === 'fill'">
      <section v-for="[g, items] in groups" :key="g" class="group">
        <h2 v-if="g">{{ g }}</h2>
        <div v-for="it in items" :key="it.id" :class="['item', { flag: flagged.includes(it.id) }]" :data-testid="`item-${it.id}`">
          <div class="item-text">{{ it.text }}<span v-if="it.isCritical" class="crit"> · {{ t('cl.critical') }}</span></div>
          <div v-if="it.hint" class="hint">{{ it.hint }}</div>
          <div class="scale">
            <button v-for="o in scaleOf(it)?.options ?? []" :key="o.value" :class="['opt', { on: run.answers[it.id]?.value === o.value }]" @click="set(it.id, { value: o.value })">{{ o.label }}</button>
            <button v-if="scaleOf(it)?.allowNa" :class="['opt', 'na', { on: run.answers[it.id]?.isNa }]" @click="set(it.id, { isNa: true })">{{ t('assess.na') }}</button>
          </div>
          <div class="photos">
            <img v-for="(p, i) in run.answers[it.id]?.photos ?? []" :key="i" :src="p.dataUrl" alt="">
            <label :class="['chip', { req: it.requiresPhoto && !(run.answers[it.id]?.photos.length) }]">📷 {{ t('cl.photo') }}{{ it.requiresPhoto ? ' *' : '' }}<input type="file" accept="image/*" capture="environment" hidden @change="photo(it.id, $event)"></label>
          </div>
          <input :value="run.answers[it.id]?.comment" class="field" :placeholder="t('assess.comment')" @input="set(it.id, { comment: ($event.target as HTMLInputElement).value })">
        </div>
      </section>
      <div class="sticky">
        <span>{{ t('cl.doneN', { n: done, total: cl.items.length }) }}</span>
        <button class="primary" :disabled="busy || done < cl.items.length" data-testid="run-finish" @click="finish">{{ t('cl.finish') }}</button>
      </div>
    </template>

    <section v-else class="group">
      <h2>{{ t('cl.result') }}</h2>
      <div :class="['score', (result ?? localScore)?.passed ? 'ok' : 'bad']">{{ (result ?? localScore)?.score }}%<small>{{ (result ?? localScore)?.passed ? t('cl.passed') : t('cl.failed') }}</small></div>
      <ul v-if="(result ?? localScore)?.failedItems.length" class="fails">
        <li v-for="id in (result ?? localScore)!.failedItems" :key="id">✕ {{ itemText(id) }}<b v-if="(result ?? localScore)!.criticalFailed.includes(id)"> — {{ t('cl.critical') }}</b></li>
      </ul>
      <template v-if="!(result ?? localScore)?.passed">
        <h3>{{ t('cl.actionPlan') }}</h3>
        <p class="hint">{{ t('cl.actionPlanHint') }}</p>
        <div v-for="a in run.actionPlan" :key="a.id" class="action">
          <input v-model="a.text" class="field" :placeholder="t('cl.whatToFix')" @input="offline.save(run!)">
          <select v-model="a.responsibleId" class="field" @change="offline.save(run!)"><option v-for="p in people" :key="p.id" :value="p.id">{{ p.fullName }}</option></select>
          <input v-model="a.dueAt" class="field" type="date" @change="offline.save(run!)">
        </div>
        <button class="chip" @click="addAction">+ {{ t('cl.actionItem') }}</button>
      </template>
      <p v-if="!offline.online.value" class="offline">{{ t('cl.willSend') }}</p>
      <div class="actions">
        <button class="chip" @click="stage = 'fill'">{{ t('common.back') }}</button>
        <button class="primary" :disabled="busy" data-testid="run-send" @click="finish">{{ t('cl.sendManager') }}</button>
      </div>
    </section>
  </div>
  <p v-else-if="error" class="error">{{ error }}</p>
</template>
<style scoped>
.back { color: var(--color-ink-muted); text-decoration: none; font-weight: 700; }
h1 { margin: var(--space-2) 0; font-weight: 900; }
h2, h3 { margin: 0; font-weight: 800; }
.group { background: var(--color-bg-soft); border-radius: var(--radius-l); padding: var(--space-3); display: grid; gap: var(--space-3); margin-bottom: var(--space-3); }
.item { display: grid; gap: var(--space-1); padding-top: var(--space-2); border-top: 1px solid var(--color-bg-line-soft); }
.item.flag { outline: 2px solid var(--color-coral); border-radius: var(--radius-m); padding: var(--space-2); }
.item-text { font-weight: 700; }
.crit { color: var(--color-coral-deep); font-size: var(--font-size-body-s); }
.hint { color: var(--color-ink-muted); font-size: var(--font-size-body-s); margin: 0; }
.scale { display: flex; flex-wrap: wrap; gap: var(--space-1); }
.opt { font: inherit; font-weight: 700; border: 1px solid var(--color-bg-line); background: var(--color-bg); border-radius: var(--radius-pill); padding: var(--space-2) var(--space-3); min-height: 44px; cursor: pointer; }
.opt.on { border-color: var(--color-ink); background: var(--color-ink); color: var(--color-bg); }
.opt.na { color: var(--color-ink-muted); }
.photos { display: flex; flex-wrap: wrap; gap: var(--space-1); align-items: center; }
.photos img { width: 56px; height: 56px; object-fit: cover; border-radius: var(--radius-s); }
.field { font: inherit; padding: var(--space-2); border: 1px solid var(--color-bg-line); border-radius: var(--radius-m); background: var(--color-bg); }
.sticky { position: sticky; bottom: calc(var(--space-7) + var(--space-2)); background: var(--color-bg-soft); border-radius: var(--radius-pill); padding: var(--space-2) var(--space-3); display: flex; justify-content: space-between; align-items: center; font-weight: 800; box-shadow: 0 4px 16px rgb(12 15 20 / 12%); }
.chip, .primary { font: inherit; font-weight: 700; border-radius: var(--radius-pill); padding: var(--space-2) var(--space-3); cursor: pointer; }
.chip { border: 1px solid var(--color-bg-line); background: transparent; color: var(--color-ink-muted); }
.chip.req { border-color: var(--color-coral-deep); color: var(--color-coral-deep); }
.primary { border: none; background: var(--color-sun); color: var(--color-ink); font-weight: 800; }
.primary:disabled { opacity: 0.5; }
.score { font-size: var(--font-size-display); font-weight: 900; display: grid; }
.score small { font-size: var(--font-size-body); }
.score.ok { color: var(--color-teal-deep); }
.score.bad { color: var(--color-coral-deep); }
.fails { list-style: none; margin: 0; padding: 0; display: grid; gap: var(--space-1); }
.action { display: grid; gap: var(--space-1); padding: var(--space-2); background: var(--color-bg); border-radius: var(--radius-m); }
.actions { display: flex; flex-wrap: wrap; gap: var(--space-2); justify-content: flex-end; }
.offline { background: var(--color-sun); color: var(--color-sun-ink); padding: var(--space-2) var(--space-3); border-radius: var(--radius-m); font-weight: 700; margin: 0 0 var(--space-2); }
.error { background: var(--color-coral); color: var(--color-coral-deep); padding: var(--space-3); border-radius: var(--radius-m); }
</style>
