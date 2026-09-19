<script setup lang="ts">
definePageMeta({ layout: 'admin', middleware: 'admin-scope', requiredScope: 'settings.tenant' })
const { t } = useI18n()
const { api } = useApi()
interface Ref { id: string, name: string }
interface Cond { cityIds?: string[], cityInvert?: boolean, positionIds?: string[], positionInvert?: boolean, orgUnitIds?: string[], orgUnitInvert?: boolean, tags?: string[], tagInvert?: boolean, courseIds?: string[] }
interface Action { type: string, subjectType?: string, subjectId?: string, dueDays?: number, tag?: string, text?: string, code?: string }
interface Rule { id: string, name: string, description: string | null, trigger: string, conditions: Cond, actions: Action[], isActive: boolean, assignDelayDays: number, runLimit: { oncePerUser: boolean }, lastRunAt: string | null, stats: { runs?: number }, usedBy: { id: string, title: string }[] }
const items = ref<Rule[]>([])
const refs = reactive({ cities: [] as Ref[], positions: [] as Ref[], orgUnits: [] as Ref[], tags: [] as Ref[], courses: [] as { id: string, title: string }[] })
const error = ref('')
const notice = ref('')
const editing = ref<string | null>(null)
const blank = () => ({ name: '', description: '', trigger: 'user.activated', assignDelayDays: 0, oncePerUser: true, isActive: true, cityIds: [] as string[], cityInvert: false, positionIds: [] as string[], positionInvert: false, orgUnitIds: [] as string[], orgUnitInvert: false, tags: [] as string[], tagInvert: false, courseIds: [] as string[], actions: [] as Action[] })
const form = reactive(blank())
const modal = ref<{ title: string, rows: { fullName: string, status?: string }[] } | null>(null)
const TRIGGERS = ['user.activated', 'user.attributes_changed', 'course.completed', 'course.failed', 'certificate.expiring', 'assignment.overdue']

async function load() {
  try {
    items.value = await api('/automation-rules')
    refs.cities = await api('/refs/cities'); refs.positions = await api('/refs/positions'); refs.orgUnits = await api('/refs/org-units'); refs.tags = await api('/refs/tags')
    refs.courses = (await api<{ id: string, title: string, status: string }[]>('/courses')).filter(c => c.status === 'published')
  } catch (err) { error.value = apiErrorOf(err).message }
}
onMounted(load)
function edit(r: Rule) {
  editing.value = r.id
  Object.assign(form, { ...blank(), name: r.name, description: r.description ?? '', trigger: r.trigger, assignDelayDays: r.assignDelayDays, oncePerUser: r.runLimit?.oncePerUser !== false, isActive: r.isActive, ...r.conditions, actions: r.actions.map(a => ({ ...a })) })
}
function reset() { editing.value = null; Object.assign(form, blank()) }
const body = () => ({ name: form.name, description: form.description || undefined, trigger: form.trigger, assignDelayDays: form.assignDelayDays, isActive: form.isActive, runLimit: { oncePerUser: form.oncePerUser }, conditions: { cityIds: form.cityIds, cityInvert: form.cityInvert, positionIds: form.positionIds, positionInvert: form.positionInvert, orgUnitIds: form.orgUnitIds, orgUnitInvert: form.orgUnitInvert, tags: form.tags, tagInvert: form.tagInvert, courseIds: form.trigger.startsWith('course.') ? form.courseIds : [] }, actions: form.actions })
async function save() {
  error.value = ''; notice.value = ''
  try {
    if (editing.value) await api(`/automation-rules/${editing.value}`, { method: 'PATCH', body: body() })
    else await api('/automation-rules', { method: 'POST', body: body() })
    notice.value = t('common.saved'); reset(); await load()
  } catch (err) { error.value = apiErrorOf(err).message }
}
async function showUsers(r: Rule) { modal.value = { title: `${r.name}: ${t('rules.usersNow')}`, rows: await api(`/automation-rules/${r.id}/users`) } }
async function run(r: Rule, dryRun: boolean) {
  error.value = ''
  try {
    const res = await api<{ total: number, ran: number, results: { fullName: string, status: string }[] }>(`/automation-rules/${r.id}/run`, { method: 'POST', body: { dryRun } })
    modal.value = { title: `${r.name}: ${dryRun ? t('rules.dryRun') : t('rules.runManual')} — ${res.ran} / ${res.total}`, rows: res.results }
    if (!dryRun) await load()
  } catch (err) { error.value = apiErrorOf(err).message }
}
async function remove(r: Rule) { if (!confirm(t('rules.deleteConfirm'))) return; try { await api(`/automation-rules/${r.id}`, { method: 'DELETE' }); await load() } catch (err) { error.value = apiErrorOf(err).message } }
const names = (ids: string[], list: Ref[]) => ids.map(id => list.find(x => x.id === id)?.name ?? '?').join(', ')
type IdsKey = 'cityIds' | 'positionIds' | 'orgUnitIds' | 'tags'
type InvKey = 'cityInvert' | 'positionInvert' | 'orgUnitInvert' | 'tagInvert'
const groups = computed((): { key: string, ids: IdsKey, invert: InvKey, list: Ref[] }[] => [
  { key: 'cities', ids: 'cityIds', invert: 'cityInvert', list: refs.cities }, { key: 'positions', ids: 'positionIds', invert: 'positionInvert', list: refs.positions },
  { key: 'orgUnits', ids: 'orgUnitIds', invert: 'orgUnitInvert', list: refs.orgUnits }, { key: 'tags', ids: 'tags', invert: 'tagInvert', list: refs.tags.map(x => ({ id: x.name, name: x.name })) },
])
// «Буде призначено» — сводка условий как в эталоне
const summary = computed(() => groups.value.map((g) => { const ids = form[g.ids]; return `${t(`rules.${g.key}`)}${ids.length ? ` (${ids.length})` : ''}: ${ids.length ? `${form[g.invert] ? `${t('rules.allExcept')} ` : ''}${names(ids, g.list)}` : t('rules.any')}` }).join('; '))
</script>
<template>
  <div>
    <h1>{{ t('admin.nav.rules') }}</h1>
    <p class="sub">{{ t('rules.hint') }}</p>
    <p v-if="error" class="error">{{ error }}</p>
    <p v-if="notice" class="notice">{{ notice }}</p>
    <table class="table">
      <thead><tr><th>{{ t('assign.col.title') }}</th><th>{{ t('rules.trigger') }}</th><th>{{ t('rules.runs') }}</th><th>{{ t('rules.lastRun') }}</th><th>{{ t('rules.usedFor') }}</th><th /></tr></thead>
      <tbody>
        <tr v-for="r in items" :key="r.id" :class="{ off: !r.isActive }">
          <td><b>{{ r.name }}</b><div v-if="r.description" class="sub">{{ r.description }}</div></td>
          <td class="sub">{{ t(`rules.triggers.${r.trigger}`, r.trigger) }}<template v-if="r.assignDelayDays"> · +{{ r.assignDelayDays }} {{ t('rules.days') }}</template></td>
          <td>{{ r.stats?.runs ?? 0 }}</td><td class="sub">{{ r.lastRunAt ? new Date(r.lastRunAt).toLocaleString('uk-UA', { dateStyle: 'short', timeStyle: 'short' }) : '—' }}</td>
          <td class="sub">{{ r.usedBy.map(u => u.title).join(', ') || '—' }}</td>
          <td class="acts">
            <button class="chip" @click="edit(r)">{{ t('common.edit') }}</button>
            <button class="chip" @click="showUsers(r)">{{ t('rules.userList') }}</button>
            <button class="chip" @click="run(r, true)">{{ t('rules.dryRun') }}</button>
            <button class="chip" @click="run(r, false)">{{ t('rules.runManual') }}</button>
            <button class="chip danger" @click="remove(r)">{{ t('rules.delete') }}</button>
          </td>
        </tr>
      </tbody>
    </table>

    <section class="card">
      <h2>{{ editing ? t('common.edit') : t('rules.new') }}</h2>
      <div class="row"><input v-model="form.name" class="field grow" :placeholder="t('rules.name')" data-testid="rule-name"><input v-model="form.description" class="field grow" :placeholder="t('rules.description')"></div>
      <h3>{{ t('rules.when') }}</h3>
      <div class="row"><label v-for="tr in TRIGGERS" :key="tr" class="check"><input v-model="form.trigger" type="radio" :value="tr"> {{ t(`rules.triggers.${tr}`) }}</label></div>
      <div v-if="form.trigger.startsWith('course.')" class="row"><span class="sub">{{ t('rules.whichCourse') }}:</span><label v-for="c in refs.courses" :key="c.id" class="check"><input v-model="form.courseIds" type="checkbox" :value="c.id"> {{ c.title }}</label></div>
      <h3>{{ t('rules.if') }}</h3>
      <div v-for="g in groups" :key="g.key" class="group">
        <div class="row"><b>{{ t(`rules.${g.key}`) }}</b><label class="check"><input v-model="form[g.invert]" type="checkbox"> {{ t('rules.allExcept') }}</label><span v-if="!form[g.ids].length" class="sub">{{ t('rules.any') }}</span></div>
        <div class="row"><label v-for="o in g.list" :key="o.id" class="check"><input v-model="form[g.ids]" type="checkbox" :value="o.id"> {{ o.name }}</label></div>
      </div>
      <p class="summary"><b>{{ t('rules.willAssign') }}:</b> {{ summary }}</p>
      <h3>{{ t('rules.then') }}</h3>
      <p class="sub">{{ t('rules.thenHint') }}</p>
      <div v-for="(a, i) in form.actions" :key="i" class="row">
        <select v-model="a.type" class="field"><option value="assign_content">{{ t('rules.act.assign_content') }}</option><option value="add_tag">{{ t('rules.act.add_tag') }}</option><option value="remove_tag">{{ t('rules.act.remove_tag') }}</option><option value="notify_user">{{ t('rules.act.notify_user') }}</option></select>
        <template v-if="a.type === 'assign_content'"><select v-model="a.subjectId" class="field grow"><option v-for="c in refs.courses" :key="c.id" :value="c.id">{{ c.title }}</option></select><label class="sub">{{ t('rules.dueDays') }} <input v-model.number="a.dueDays" class="field short" type="number" min="1" max="365"></label></template>
        <input v-else-if="a.type === 'add_tag' || a.type === 'remove_tag'" v-model="a.tag" class="field" :placeholder="t('rules.tag')">
        <input v-else v-model="a.text" class="field grow" :placeholder="t('rules.text')">
        <button class="chip" @click="form.actions.splice(i, 1)">✕</button>
      </div>
      <div class="row">
        <button class="chip" @click="form.actions.push({ type: 'assign_content', subjectType: 'course', subjectId: refs.courses[0]?.id, dueDays: 14 })">+ {{ t('rules.action') }}</button>
        <label class="sub">{{ t('rules.delay') }} <input v-model.number="form.assignDelayDays" class="field short" type="number" min="0" max="365"></label>
        <label class="check"><input v-model="form.oncePerUser" type="checkbox"> {{ t('rules.oncePerUser') }}</label>
        <label class="check"><input v-model="form.isActive" type="checkbox"> {{ t('rules.publish') }}</label>
      </div>
      <div class="row"><button class="primary" :disabled="form.name.length < 2" data-testid="rule-save" @click="save">{{ t('common.save') }}</button><button v-if="editing" class="chip" @click="reset">{{ t('common.cancel') }}</button></div>
    </section>

    <div v-if="modal" class="modal-backdrop" @click.self="modal = null">
      <div class="modal">
        <h2>{{ modal.title }}</h2>
        <ul class="list"><li v-for="(r, i) in modal.rows" :key="i">{{ r.fullName }}<span v-if="r.status" class="sub"> · {{ r.status }}</span></li><li v-if="!modal.rows.length" class="sub">—</li></ul>
      </div>
    </div>
  </div>
</template>
<style scoped>
h1 { margin: 0 0 var(--space-1); font-weight: 900; }
h2, h3 { margin: 0; font-weight: 800; }
h3 { font-size: var(--font-size-body); margin-top: var(--space-2); }
.table { width: 100%; border-collapse: collapse; background: var(--color-bg-soft); border-radius: var(--radius-m); overflow: hidden; margin: var(--space-3) 0 var(--space-4); }
th { text-align: left; font-size: var(--font-size-body-s); color: var(--color-ink-muted); padding: var(--space-2) var(--space-3); border-bottom: 1px solid var(--color-bg-line); }
td { padding: var(--space-2) var(--space-3); border-bottom: 1px solid var(--color-bg-line-soft); vertical-align: top; }
tr.off { opacity: 0.5; }
.acts { display: flex; gap: var(--space-1); flex-wrap: wrap; }
.card { background: var(--color-bg-soft); border-radius: var(--radius-l); padding: var(--space-4); display: grid; gap: var(--space-2); }
.group { background: var(--color-bg); border-radius: var(--radius-m); padding: var(--space-2) var(--space-3); display: grid; gap: var(--space-1); }
.summary { margin: 0; padding: var(--space-2) var(--space-3); background: var(--color-sun); color: var(--color-sun-ink); border-radius: var(--radius-m); font-size: var(--font-size-body-s); }
.field, select { font: inherit; border: 1px solid var(--color-bg-line); border-radius: var(--radius-s); padding: var(--space-2) var(--space-3); background: var(--color-bg); color: var(--color-ink); }
.short { width: 70px; }
.grow { flex: 1; min-width: 160px; }
.row { display: flex; gap: var(--space-2); align-items: center; flex-wrap: wrap; }
.check { display: flex; gap: var(--space-1); align-items: center; font-size: var(--font-size-body-s); }
.chip { font: inherit; font-size: var(--font-size-body-s); font-weight: 700; border: 1px solid var(--color-bg-line); background: transparent; color: var(--color-ink-muted); border-radius: var(--radius-pill); padding: var(--space-1) var(--space-3); cursor: pointer; }
.chip.danger { color: var(--color-coral-ink); }
.primary { font: inherit; font-weight: 800; border: none; background: var(--color-sun); color: var(--color-ink); border-radius: var(--radius-pill); padding: var(--space-2) var(--space-4); cursor: pointer; }
.primary:disabled { opacity: 0.5; }
.sub { font-size: var(--font-size-body-s); color: var(--color-ink-faint); margin: 0; }
.error { color: var(--color-coral-ink); }
.notice { color: var(--color-teal-ink); }
.modal-backdrop { position: fixed; inset: 0; z-index: 20; overflow: auto; background: rgb(12 15 20 / 40%); display: grid; place-items: center; padding: var(--space-4); }
.modal { background: var(--color-bg-soft); border-radius: var(--radius-xl); padding: var(--space-5); width: min(480px, 100%); box-sizing: border-box; display: grid; gap: var(--space-3); max-height: 80dvh; overflow: auto; }
.list { list-style: none; margin: 0; padding: 0; display: grid; gap: var(--space-1); }
</style>
