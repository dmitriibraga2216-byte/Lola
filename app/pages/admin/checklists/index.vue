<script setup lang="ts">
definePageMeta({ layout: 'admin', middleware: 'admin-scope', requiredScope: 'checklist.manage' })
const { t } = useI18n()
const { api } = useApi()
interface Item { id: string, group?: string, text: string, scaleId: string, weight: number, isCritical?: boolean, requiresPhoto?: boolean, hint?: string }
interface CL { id: string, title: string, kind: string, subject_kind: string, scoring: string, pass_score: string, items: Item[], is_active: boolean, runs: number, frequency: { timesPerWeek: number } | null, critical_fail_rule: string, who_can_run: { roles: string[] }, require_signature?: boolean }
interface Wave { id: string, title: string, checklist_id: string, checklist_title: string, starts_at: string, ends_at: string, status: string, links: number, done: number, avg_score: string | null }
interface Link { id: string, location: string, expires_at: string, used_at: string | null, score: string | null, passed: boolean | null }
const items = ref<CL[]>([])
const scales = ref<{ id: string, name: string }[]>([])
const error = ref('')
const notice = ref('')
const editing = ref<string | null>(null)
const blank = () => ({ title: '', kind: 'observation', subjectKind: 'location', scoring: 'percent', passScore: 80, criticalFailRule: 'any_critical_fails_all', roles: ['mentor', 'manager', 'admin'] as string[], timesPerWeek: 0, requireSignature: false, items: [] as Item[] })
const form = reactive(blank())
const newItem = () => ({ id: crypto.randomUUID().slice(0, 8), group: '', text: '', scaleId: scales.value[0]?.id ?? '', weight: 1, isCritical: false, requiresPhoto: false, hint: '' })
async function load() { try { items.value = await api('/checklists'); scales.value = await api('/rating-scales') } catch (err) { error.value = apiErrorOf(err).message } }
onMounted(load)
function edit(c: CL) { editing.value = c.id; Object.assign(form, { title: c.title, kind: c.kind, subjectKind: c.subject_kind, scoring: c.scoring, passScore: Number(c.pass_score), criticalFailRule: c.critical_fail_rule, roles: [...c.who_can_run.roles], timesPerWeek: c.frequency?.timesPerWeek ?? 0, requireSignature: c.require_signature ?? false, items: c.items.map(i => ({ ...i, group: i.group ?? '', hint: i.hint ?? '', isCritical: i.isCritical ?? false, requiresPhoto: i.requiresPhoto ?? false })) }) }
function reset() { editing.value = null; Object.assign(form, blank()) }
async function save() {
  error.value = ''; notice.value = ''
  try {
    await api('/checklists', { method: 'PUT', body: { id: editing.value ?? undefined, title: form.title, kind: form.kind, subjectKind: form.subjectKind, scoring: form.scoring, passScore: form.passScore, criticalFailRule: form.criticalFailRule, whoCanRun: { roles: form.roles }, frequency: form.timesPerWeek ? { timesPerWeek: form.timesPerWeek } : null, requireSignature: form.requireSignature, items: form.items.filter(i => i.text.trim()).map(i => ({ ...i, group: i.group || undefined, hint: i.hint || undefined })) } })
    notice.value = t('common.saved'); reset(); await load()
  } catch (err) { error.value = apiErrorOf(err).message }
}
// Тайный покупатель (docs/20 §7.8): волны и одноразовые ссылки
const { hasScope } = useAuth()
const waves = ref<Wave[]>([])
const locations = ref<{ id: string, name: string }[]>([])
const waveForm = reactive({ checklistId: '', title: '', startsAt: '', endsAt: '' })
const openWave = ref<string | null>(null)
const links = ref<Link[]>([])
const linkLocation = ref('')
const newUrl = ref('')
const mysteryChecklists = computed(() => items.value.filter(c => c.kind === 'mystery' && c.is_active))
async function loadWaves() { if (!hasScope('report.tenant')) return; try { waves.value = await api('/mystery/waves'); locations.value = await api('/refs/locations') } catch { /* нет прав */ } }
onMounted(loadWaves)
async function createWave() { error.value = ''; try { await api('/mystery/waves', { method: 'POST', body: waveForm }); Object.assign(waveForm, { title: '', startsAt: '', endsAt: '' }); await loadWaves() } catch (err) { error.value = apiErrorOf(err).message } }
async function setWave(w: Wave, status: string) { try { await api(`/mystery/waves/${w.id}/status`, { method: 'POST', body: { status } }); await loadWaves() } catch (err) { error.value = apiErrorOf(err).message } }
async function showLinks(w: Wave) { openWave.value = openWave.value === w.id ? null : w.id; newUrl.value = ''; if (openWave.value) links.value = await api(`/mystery/waves/${w.id}/links`) }
async function makeLink() {
  if (!openWave.value || !linkLocation.value) return
  try { const r = await api<{ url: string, token: string }>(`/mystery/waves/${openWave.value}/links`, { method: 'POST', body: { locationId: linkLocation.value } }); newUrl.value = r.url.startsWith('http') ? r.url : `${location.origin}/m/${r.token}`; links.value = await api(`/mystery/waves/${openWave.value}/links`) }
  catch (err) { error.value = apiErrorOf(err).message }
}
async function copy(text: string) { try { await navigator.clipboard.writeText(text); notice.value = t('mystery.copied') } catch { /* буфер недоступен */ } }
const fmt = (d: string | null) => d ? new Date(d).toLocaleString('uk') : '—'
async function toggle(c: CL) { await api('/checklists', { method: 'PUT', body: { id: c.id, title: c.title, kind: c.kind, subjectKind: c.subject_kind, scoring: c.scoring, passScore: Number(c.pass_score), criticalFailRule: c.critical_fail_rule, whoCanRun: c.who_can_run, frequency: c.frequency, items: c.items, isActive: !c.is_active } }); await load() }
</script>
<template>
  <div>
    <h1>{{ t('admin.nav.checklists') }}</h1>
    <p v-if="error" class="error">{{ error }}</p>
    <p v-if="notice" class="notice">{{ notice }}</p>
    <table class="table">
      <thead><tr><th>{{ t('assign.col.title') }}</th><th>{{ t('assign.col.kind') }}</th><th>{{ t('cl.items') }}</th><th>{{ t('cl.runs') }}</th><th /></tr></thead>
      <tbody>
        <tr v-for="c in items" :key="c.id" :class="{ off: !c.is_active }">
          <td><b>{{ c.title }}</b><div class="sub">{{ t(`cl.subject.${c.subject_kind}`) }} · {{ c.scoring }} ≥ {{ c.pass_score }}<template v-if="c.frequency"> · {{ c.frequency.timesPerWeek }}/{{ t('cl.week') }}</template></div></td>
          <td class="sub">{{ t(`cl.kind.${c.kind}`) }}</td><td>{{ c.items.length }}</td><td>{{ c.runs }}</td>
          <td class="acts"><button class="chip" @click="edit(c)">{{ t('common.edit') }}</button><button class="chip" @click="toggle(c)">{{ c.is_active ? t('common.deactivate') : t('common.activate') }}</button></td>
        </tr>
      </tbody>
    </table>
    <section class="card">
      <h2>{{ editing ? t('common.edit') : t('cl.new') }}</h2>
      <div class="row">
        <input v-model="form.title" class="field grow" :placeholder="t('cl.titleHint')" data-testid="cl-title">
        <select v-model="form.kind" class="field"><option v-for="k in ['observation', 'audit', 'mystery']" :key="k" :value="k">{{ t(`cl.kind.${k}`) }}</option></select>
        <label class="check"><input v-model="form.requireSignature" type="checkbox"> {{ t('cl.requireSignature') }}</label>
        <select v-model="form.subjectKind" class="field"><option v-for="k in ['location', 'user', 'shift']" :key="k" :value="k">{{ t(`cl.subject.${k}`) }}</option></select>
      </div>
      <div class="row">
        <select v-model="form.scoring" class="field"><option value="percent">{{ t('cl.scoring.percent') }}</option><option value="points">{{ t('cl.scoring.points') }}</option><option value="pass_fail">{{ t('cl.scoring.pass_fail') }}</option></select>
        <label class="sub">{{ t('cl.passScore') }} <input v-model.number="form.passScore" class="field short" type="number" min="1" max="100"></label>
        <label class="check"><input v-model="form.criticalFailRule" type="checkbox" true-value="any_critical_fails_all" false-value="none"> {{ t('cl.criticalRule') }}</label>
        <label class="sub">{{ t('cl.timesPerWeek') }} <input v-model.number="form.timesPerWeek" class="field short" type="number" min="0" max="50"></label>
      </div>
      <div class="row"><span class="sub">{{ t('cl.whoCanRun') }}:</span><label v-for="r in ['mentor', 'manager', 'author', 'admin']" :key="r" class="check"><input v-model="form.roles" type="checkbox" :value="r"> {{ r }}</label></div>
      <h3>{{ t('cl.items') }}</h3>
      <div v-for="(it, i) in form.items" :key="it.id" class="row item">
        <input v-model="it.group" class="field" :placeholder="t('cl.group')">
        <input v-model="it.text" class="field grow" :placeholder="t('cl.itemText')" :data-testid="`item-text-${i}`">
        <select v-model="it.scaleId" class="field"><option v-for="s in scales" :key="s.id" :value="s.id">{{ s.name }}</option></select>
        <label class="sub">×<input v-model.number="it.weight" class="field short" type="number" step="0.5" min="0.1"></label>
        <label class="check" :title="t('cl.criticalHint')"><input v-model="it.isCritical" type="checkbox"> {{ t('cl.critical') }}</label>
        <label class="check"><input v-model="it.requiresPhoto" type="checkbox"> {{ t('cl.photoRequired') }}</label>
        <input v-model="it.hint" class="field grow" :placeholder="t('cl.hint')" maxlength="300">
        <button class="chip" @click="form.items.splice(i, 1)">✕</button>
      </div>
      <div class="row">
        <button class="chip" data-testid="item-add" @click="form.items.push(newItem())">+ {{ t('cl.item') }}</button>
        <button class="primary" :disabled="form.title.length < 3 || !form.items.some(i => i.text.trim()) || !form.roles.length" data-testid="cl-save" @click="save">{{ t('common.save') }}</button>
        <button v-if="editing" class="chip" @click="reset">{{ t('common.cancel') }}</button>
      </div>
    </section>
  
    <section v-if="hasScope('report.tenant')" class="card mystery">
      <h2>{{ t('mystery.waves') }}</h2>
      <p class="sub">{{ t('mystery.wavesHint') }}</p>
      <div class="row">
        <select v-model="waveForm.checklistId" class="field"><option value="" disabled>{{ t('cl.checklist') }}</option><option v-for="c in mysteryChecklists" :key="c.id" :value="c.id">{{ c.title }}</option></select>
        <input v-model="waveForm.title" class="field" :placeholder="t('mystery.waveTitle')">
        <input v-model="waveForm.startsAt" class="field" type="date"><input v-model="waveForm.endsAt" class="field" type="date">
        <button class="chip" :disabled="!waveForm.checklistId || !waveForm.title || !waveForm.startsAt || !waveForm.endsAt" @click="createWave">+ {{ t('mystery.newWave') }}</button>
      </div>
      <p v-if="mysteryChecklists.length === 0" class="sub">{{ t('mystery.noChecklists') }}</p>
      <table v-if="waves.length" class="table">
        <thead><tr><th>{{ t('mystery.wave') }}</th><th>{{ t('cl.checklist') }}</th><th>{{ t('assign.col.status') }}</th><th>{{ t('mystery.linksDone') }}</th><th>%</th><th /></tr></thead>
        <tbody>
          <template v-for="w in waves" :key="w.id">
            <tr>
              <td><b>{{ w.title }}</b><div class="sub">{{ w.starts_at }} — {{ w.ends_at }}</div></td><td>{{ w.checklist_title }}</td>
              <td><span :class="['badge', w.status]">{{ t(`mystery.status.${w.status}`) }}</span></td><td>{{ w.done }} / {{ w.links }}</td><td>{{ w.avg_score ?? '—' }}</td>
              <td class="acts">
                <button class="chip" @click="showLinks(w)">{{ t('mystery.links') }}</button>
                <button v-if="w.status === 'active'" class="chip" @click="setWave(w, 'published')">{{ t('mystery.publish') }}</button>
                <button v-if="w.status !== 'closed'" class="chip" @click="setWave(w, 'closed')">{{ t('mystery.close') }}</button>
              </td>
            </tr>
            <tr v-if="openWave === w.id"><td colspan="6" class="links">
              <div v-if="w.status === 'active'" class="row">
                <select v-model="linkLocation" class="field"><option value="" disabled>{{ t('person.location') }}</option><option v-for="l in locations" :key="l.id" :value="l.id">{{ l.name }}</option></select>
                <button class="chip" :disabled="!linkLocation" @click="makeLink">{{ t('mystery.makeLink') }}</button>
                <template v-if="newUrl"><code class="url">{{ newUrl }}</code><button class="chip" @click="copy(newUrl)">{{ t('mystery.copy') }}</button><span class="sub">{{ t('mystery.linkOnce') }}</span></template>
              </div>
              <table class="table plain"><thead><tr><th>{{ t('person.location') }}</th><th>{{ t('mystery.expires') }}</th><th>{{ t('mystery.used') }}</th><th>%</th></tr></thead>
                <tbody><tr v-for="l in links" :key="l.id"><td>{{ l.location }}</td><td class="sub">{{ fmt(l.expires_at) }}</td><td class="sub">{{ l.used_at ? fmt(l.used_at) : '—' }}</td><td>{{ l.score ?? '—' }}</td></tr></tbody></table>
            </td></tr>
          </template>
        </tbody>
      </table>
    </section>
</div>
</template>
<style scoped>
h1 { margin: 0 0 var(--space-4); font-weight: 900; }
h2, h3 { margin: 0; font-weight: 800; }
.table { width: 100%; border-collapse: collapse; background: var(--color-bg-soft); border-radius: var(--radius-m); overflow: hidden; margin-bottom: var(--space-4); }
th { text-align: left; font-size: var(--font-size-body-s); color: var(--color-ink-muted); padding: var(--space-2) var(--space-3); border-bottom: 1px solid var(--color-bg-line); }
td { padding: var(--space-2) var(--space-3); border-bottom: 1px solid var(--color-bg-line-soft); vertical-align: top; }
tr.off { opacity: 0.5; }
.acts { display: flex; gap: var(--space-1); }
.card { background: var(--color-bg-soft); border-radius: var(--radius-l); padding: var(--space-4); display: grid; gap: var(--space-3); }
.field, select { font: inherit; border: 1px solid var(--color-bg-line); border-radius: var(--radius-s); padding: var(--space-2) var(--space-3); background: var(--color-bg); color: var(--color-ink); }
.short { width: 70px; }
.grow { flex: 1; min-width: 140px; }
.row { display: flex; gap: var(--space-2); align-items: center; flex-wrap: wrap; }
.item { padding: var(--space-2); background: var(--color-bg); border-radius: var(--radius-m); }
.check { display: flex; gap: var(--space-1); align-items: center; font-size: var(--font-size-body-s); }
.chip { font: inherit; font-size: var(--font-size-body-s); font-weight: 700; border: 1px solid var(--color-bg-line); background: transparent; color: var(--color-ink-muted); border-radius: var(--radius-pill); padding: var(--space-1) var(--space-3); cursor: pointer; }
.primary { font: inherit; font-weight: 800; border: none; background: var(--color-sun); color: var(--color-ink); border-radius: var(--radius-pill); padding: var(--space-2) var(--space-4); cursor: pointer; }
.primary:disabled { opacity: 0.5; }
.sub { font-size: var(--font-size-body-s); color: var(--color-ink-faint); }
.error { color: var(--color-coral-ink); }
.notice { color: var(--color-teal-ink); }
.mystery { margin-top: var(--space-4); }
.links { background: var(--color-bg); }
.url { font-size: var(--font-size-body-s); word-break: break-all; }
.badge { font-size: var(--font-size-body-s); font-weight: 700; border-radius: var(--radius-pill); padding: 2px var(--space-3); background: var(--color-bg-line-soft); }
.badge.published { background: var(--color-teal); color: var(--color-teal-deep); }
.badge.active { background: var(--color-sun); color: var(--color-sun-ink); }
</style>
