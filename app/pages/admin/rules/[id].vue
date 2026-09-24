<script setup lang="ts">
/**
 * Форма правила по мокапу AutomationRule: «Коли спрацьовує», четыре измерения с сегментом
 * «Будь-який / Тільки ці / Усі, крім», живая сводка «Буде призначено N людей на зараз» + «Показати список»,
 * «Відкладене призначення», «Використовується для». Дополнительно (docs/15 §3.6): тригеры по курсу, действия, запуск вручную.
 */
const { formatDateTime } = useFormat()
definePageMeta({ layout: 'admin', middleware: 'admin-scope', requiredScope: 'settings.tenant' })
const { t } = useI18n()
const { api } = useApi()
const route = useRoute()
const router = useRouter()
const id = computed(() => route.params.id as string)
const isNew = computed(() => id.value === 'new')

type Dimension = 'city' | 'position' | 'org_unit' | 'tag'
type Mode = 'any' | 'include' | 'exclude'
interface RefItem { id: string, name: string }
interface Action { type: string, subjectType?: string, subjectId?: string, dueDays?: number, tag?: string, text?: string, code?: string }
interface Rule { id: string, name: string, description: string | null, trigger: string, conditions: { courseIds?: string[], daysBefore?: number }, actions: Action[], isActive: boolean, assignDelayDays: number, onLeaveCondition: string, runLimit: { oncePerUser: boolean }, lastRunAt: string | null, stats: { runs?: number }, dimensions: { dimension: Dimension, mode: Mode, valueIds: string[] }[], usedBy: { kind: string, id: string, title: string }[] }

const DIMENSIONS: Dimension[] = ['city', 'position', 'org_unit', 'tag']
const MODES: Mode[] = ['any', 'include', 'exclude']
const TRIGGERS = ['user.activated', 'user.attributes_changed', 'course.completed', 'course.failed', 'certificate.expiring', 'assignment.overdue']
const refs = reactive<Record<Dimension, RefItem[]>>({ city: [], position: [], org_unit: [], tag: [] })
const courses = ref<{ id: string, title: string }[]>([])
const form = reactive({
  name: '', description: '', trigger: 'user.activated', assignDelayDays: 0, isActive: true, oncePerUser: true, onLeaveCondition: 'keep', courseIds: [] as string[], actions: [] as Action[],
  dims: Object.fromEntries(DIMENSIONS.map(d => [d, { mode: 'any' as Mode, valueIds: [] as string[] }])) as Record<Dimension, { mode: Mode, valueIds: string[] }>,
})
const usedBy = ref<Rule['usedBy']>([])
const stats = ref<{ runs?: number, lastRunAt?: string | null }>({})
const preview = ref<{ count: number, people: { id: string, fullName: string }[] } | null>(null)
const showList = ref(false)
const error = ref('')
const notice = ref('')
const modal = ref<{ title: string, rows: { fullName: string, status?: string }[] } | null>(null)

async function load() {
  try {
    const [c, p, o, tg] = await Promise.all([api<RefItem[]>('/refs/cities'), api<RefItem[]>('/refs/positions'), api<RefItem[]>('/refs/org-units'), api<RefItem[]>('/refs/tags?scope=user')])
    refs.city = c; refs.position = p; refs.org_unit = o; refs.tag = tg
    courses.value = (await api<{ id: string, title: string, status: string }[]>('/courses')).filter(x => x.status === 'published')
    if (!isNew.value) {
      const r = await api<Rule>(`/automation-rules/${id.value}`)
      Object.assign(form, { name: r.name, description: r.description ?? '', trigger: r.trigger, assignDelayDays: r.assignDelayDays, isActive: r.isActive, oncePerUser: r.runLimit?.oncePerUser !== false, onLeaveCondition: r.onLeaveCondition ?? 'keep', courseIds: r.conditions?.courseIds ?? [], actions: r.actions.map(a => ({ ...a })) })
      for (const d of r.dimensions) form.dims[d.dimension] = { mode: d.mode, valueIds: [...d.valueIds] }
      usedBy.value = r.usedBy; stats.value = { runs: r.stats?.runs, lastRunAt: r.lastRunAt }
    }
    await refreshPreview()
  }
  catch (err) { error.value = apiErrorOf(err).message }
}
onMounted(load)

const dimensionsBody = () => DIMENSIONS.map(d => ({ dimension: d, mode: form.dims[d].mode, valueIds: form.dims[d].mode === 'any' ? [] : form.dims[d].valueIds }))
let previewTimer: ReturnType<typeof setTimeout> | undefined
async function refreshPreview() {
  try { preview.value = await api('/automation-rules/preview', { method: 'POST', body: { dimensions: dimensionsBody() } }) }
  catch { preview.value = null }
}
watch(() => JSON.stringify(dimensionsBody()), () => { clearTimeout(previewTimer); previewTimer = setTimeout(refreshPreview, 300) })

const body = () => ({
  name: form.name, description: form.description || undefined, trigger: form.trigger, assignDelayDays: form.assignDelayDays, isActive: form.isActive, onLeaveCondition: form.onLeaveCondition,
  runLimit: { oncePerUser: form.oncePerUser }, dimensions: dimensionsBody(), conditions: { courseIds: form.trigger.startsWith('course.') ? form.courseIds : [] }, actions: form.actions,
})
async function save() {
  error.value = ''; notice.value = ''
  try {
    if (isNew.value) { const r = await api<{ id: string }>('/automation-rules', { method: 'POST', body: body() }); await router.replace(`/admin/rules/${r.id}`); await load() }
    else { await api(`/automation-rules/${id.value}`, { method: 'PATCH', body: body() }); await load() }
    notice.value = t('common.saved')
  }
  catch (err) { error.value = apiErrorOf(err).message }
}
async function run(dryRun: boolean) {
  error.value = ''
  try {
    const res = await api<{ total: number, ran: number, results: { fullName: string, status: string }[] }>(`/automation-rules/${id.value}/run`, { method: 'POST', body: { dryRun } })
    modal.value = { title: `${dryRun ? t('rules.dryRun') : t('rules.runManual')} — ${res.ran} / ${res.total}`, rows: res.results }
    if (!dryRun) await load()
  }
  catch (err) { error.value = apiErrorOf(err).message }
}
async function remove() {
  if (!confirm(t('rules.deleteConfirm'))) return
  try { await api(`/automation-rules/${id.value}`, { method: 'DELETE' }); await navigateTo('/admin/rules') } catch (err) { error.value = apiErrorOf(err).message }
}
function toggleValue(d: Dimension, valueId: string) {
  const list = form.dims[d].valueIds
  const i = list.indexOf(valueId)
  if (i >= 0) list.splice(i, 1); else list.push(valueId)
}
const usageLink = (u: { kind: string, id: string }) => u.kind === 'trajectory' ? `/admin/trajectories/${u.id}` : u.kind === 'program' ? `/admin/programs/${u.id}` : `/admin/assignments/${u.id}`
</script>

<template>
  <div>
    <PageHeader :title="isNew ? t('rules.new') : form.name" :crumbs="[{ label: t('admin.section.learning') }, { label: t('admin.nav.rules'), to: '/admin/rules' }]">
      <template #actions>
        <button v-if="!isNew" class="btn ghost" @click="run(true)">{{ t('rules.dryRun') }}</button>
        <button v-if="!isNew" class="btn ghost" @click="run(false)">{{ t('rules.runManual') }}</button>
        <button class="btn primary" :disabled="form.name.length < 2" data-testid="rule-save" @click="save">{{ t('common.save') }}</button>
      </template>
    </PageHeader>
    <p v-if="error" class="error-text" role="alert">{{ error }}</p>
    <p v-if="notice" class="note teal">{{ notice }}</p>

    <div class="layout">
      <div class="main">
        <section class="card">
          <label class="label" for="rule-name">{{ t('rules.name') }}</label>
          <input id="rule-name" v-model="form.name" class="field" data-testid="rule-name" required minlength="2">
          <label class="label" for="rule-desc">{{ t('rules.description') }}</label>
          <textarea id="rule-desc" v-model="form.description" class="field" rows="2" />
        </section>

        <section class="card">
          <h2 class="panel-title">{{ t('rules.whenTitle') }}</h2>
          <p class="help">{{ t('rules.whenHint') }}</p>
          <select v-model="form.trigger" class="field" :aria-label="t('rules.trigger')">
            <option v-for="tr in TRIGGERS" :key="tr" :value="tr">{{ t(`rules.triggers.${tr}`) }}</option>
          </select>
          <template v-if="form.trigger.startsWith('course.')">
            <label class="label">{{ t('rules.whichCourse') }}</label>
            <select v-model="form.courseIds" multiple class="field" size="4"><option v-for="c in courses" :key="c.id" :value="c.id">{{ c.title }}</option></select>
          </template>
        </section>

        <section v-for="d in DIMENSIONS" :key="d" class="card dim">
          <div class="dim-head">
            <h2 class="panel-title">{{ t(`rules.dim.${d}`) }}</h2>
            <div class="segmented" role="radiogroup" :aria-label="t(`rules.dim.${d}`)">
              <button v-for="m in MODES" :key="m" type="button" role="radio" :aria-checked="form.dims[d].mode === m" :class="['seg', { on: form.dims[d].mode === m }]" @click="form.dims[d].mode = m">{{ t(`rules.mode.${m}`) }}</button>
            </div>
          </div>
          <div v-if="form.dims[d].mode !== 'any'" class="chips values">
            <button v-for="v in refs[d]" :key="v.id" type="button" :class="['chip', { on: form.dims[d].valueIds.includes(v.id) }]" :aria-pressed="form.dims[d].valueIds.includes(v.id)" @click="toggleValue(d, v.id)">{{ v.name }}</button>
            <span v-if="!refs[d].length" class="help">{{ t('rules.noValues') }}</span>
          </div>
          <p v-else class="help">{{ t('rules.anyValue') }}</p>
        </section>

        <section class="card">
          <h2 class="panel-title">{{ t('rules.delayTitle') }}</h2>
          <p class="help">{{ t('rules.delayHint') }}</p>
          <label class="inline"><span>{{ t('rules.assignAfter') }}</span><input v-model.number="form.assignDelayDays" type="number" min="0" max="365" class="field days"><span>{{ t('rules.days') }}</span></label>
          <label class="toggle"><input v-model="form.isActive" type="checkbox"><span>{{ t('rules.publish') }}</span></label>
          <label class="toggle"><input v-model="form.oncePerUser" type="checkbox"><span>{{ t('rules.oncePerUser') }}</span></label>
          <label class="label" for="rule-leave">{{ t('rules.onLeave') }}</label>
          <select id="rule-leave" v-model="form.onLeaveCondition" class="field">
            <option value="keep">{{ t('rules.onLeaveOpt.keep') }}</option><option value="cancel_unstarted">{{ t('rules.onLeaveOpt.cancel_unstarted') }}</option><option value="cancel_all">{{ t('rules.onLeaveOpt.cancel_all') }}</option>
          </select>
        </section>

        <section class="card">
          <h2 class="panel-title">{{ t('rules.then') }}</h2>
          <p class="help">{{ t('rules.thenHint') }}</p>
          <div v-for="(a, i) in form.actions" :key="i" class="action">
            <select v-model="a.type" class="field small"><option value="assign_content">{{ t('rules.act.assign_content') }}</option><option value="add_tag">{{ t('rules.act.add_tag') }}</option><option value="remove_tag">{{ t('rules.act.remove_tag') }}</option><option value="notify_user">{{ t('rules.act.notify_user') }}</option></select>
            <select v-if="a.type === 'assign_content'" v-model="a.subjectId" class="field small"><option v-for="c in courses" :key="c.id" :value="c.id">{{ c.title }}</option></select>
            <input v-if="a.type === 'assign_content'" v-model.number="a.dueDays" type="number" min="1" class="field small days" :placeholder="t('rules.dueDays')">
            <input v-if="a.type === 'add_tag' || a.type === 'remove_tag'" v-model="a.tag" class="field small" :placeholder="t('rules.tag')">
            <input v-if="a.type === 'notify_user'" v-model="a.text" class="field small" :placeholder="t('rules.text')">
            <button class="chip" type="button" @click="form.actions.splice(i, 1)">×</button>
          </div>
          <button class="chip outline" type="button" @click="form.actions.push({ type: 'assign_content', subjectType: 'course', subjectId: courses[0]?.id, dueDays: 14 })">+ {{ t('rules.action') }}</button>
        </section>
      </div>

      <aside class="side">
        <section class="card">
          <h2 class="panel-title">{{ t('rules.willAssign') }}</h2>
          <p class="big"><template v-if="preview">{{ t('rules.peopleNow', { n: preview.count }) }}</template><template v-else>—</template></p>
          <button v-if="preview?.count" class="chip outline" type="button" @click="showList = !showList">{{ showList ? t('rules.hideList') : t('rules.showList') }}</button>
          <ul v-if="showList && preview" class="people">
            <li v-for="p in preview.people" :key="p.id">{{ p.fullName }}</li>
          </ul>
        </section>
        <section v-if="!isNew" class="card">
          <h2 class="panel-title">{{ t('rules.usedFor') }}</h2>
          <ul v-if="usedBy.length" class="uses">
            <li v-for="u in usedBy" :key="u.id"><NuxtLink :to="usageLink(u)" class="link">{{ u.title }}</NuxtLink> <span class="muted">· {{ t(`rules.usage.${u.kind}`) }}</span></li>
          </ul>
          <p v-else class="help">{{ t('rules.notUsed') }}</p>
          <p class="help">{{ t('rules.runs') }}: {{ stats.runs ?? 0 }}<template v-if="stats.lastRunAt"> · {{ t('rules.lastRun') }} {{ formatDateTime(new Date(stats.lastRunAt), { dateStyle: 'short', timeStyle: 'short' }) }}</template></p>
          <button class="btn danger small" type="button" :disabled="usedBy.length > 0" @click="remove">{{ t('rules.delete') }}</button>
        </section>
      </aside>
    </div>

    <div v-if="modal" class="modal-back" @click.self="modal = null">
      <div class="modal card" role="dialog" aria-modal="true" :aria-label="modal.title">
        <h2 class="panel-title">{{ modal.title }}</h2>
        <ul class="people"><li v-for="(r, i) in modal.rows" :key="i">{{ r.fullName }}<span v-if="r.status" class="muted"> · {{ r.status }}</span></li></ul>
        <button class="btn ghost" @click="modal = null">{{ t('common.close') }}</button>
      </div>
    </div>
  </div>
</template>

<style scoped>
.layout { display: grid; grid-template-columns: minmax(0, 1fr) 300px; gap: var(--space-4); }
.main, .side { display: grid; gap: var(--space-3); align-content: start; }
.label { margin-top: var(--space-2); }
.dim-head { display: flex; justify-content: space-between; align-items: center; gap: var(--space-3); flex-wrap: wrap; }
.dim .panel-title { margin: 0; }
.seg { font: inherit; font-weight: 700; font-size: var(--font-size-body-s); border: none; background: transparent; color: var(--color-ink-muted); border-radius: var(--radius-pill); padding: var(--space-1) var(--space-3); cursor: pointer; }
.seg.on { background: var(--color-ink); color: var(--color-bg); }
.values { margin-top: var(--space-3); }
.inline { display: flex; gap: var(--space-2); align-items: center; font-weight: 700; margin-bottom: var(--space-3); }
.days { width: 90px; }
.toggle { display: flex; margin-bottom: var(--space-2); }
.action { display: flex; gap: var(--space-2); flex-wrap: wrap; align-items: center; margin-bottom: var(--space-2); }
.field.small { width: auto; padding: var(--space-1) var(--space-2); font-size: var(--font-size-body-s); }
.big { font-size: var(--font-size-title-l); font-weight: 900; margin: 0 0 var(--space-2); }
.people, .uses { margin: var(--space-2) 0 0; padding-left: var(--space-4); font-size: var(--font-size-body-s); display: grid; gap: var(--space-1); }
.modal-back { position: fixed; inset: 0; background: rgb(12 15 20 / 0.4); display: grid; place-items: center; z-index: 20; padding: var(--space-4); }
.modal { width: min(480px, 100%); max-height: 80vh; overflow: auto; display: grid; gap: var(--space-3); }
@media (max-width: 900px) { .layout { grid-template-columns: 1fr; } }
</style>
