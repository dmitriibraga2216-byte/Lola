<script setup lang="ts">
definePageMeta({ layout: 'admin', middleware: 'admin-scope', requiredScope: 'checklist.manage' })
const { t } = useI18n()
const { api } = useApi()
/** Чек-листи за мокапом Checklists: назва · пунктів · шкала · підрахунок · дата зміни · опубліковано; одна шкала, у пункту вага (docs/20 §14.3). */
interface Item { id: string, group?: string, text: string, criterionId?: string, weight: number, isCritical?: boolean, requiresPhoto?: boolean, hint?: string, passThreshold?: number | null }
interface CL { id: string, title: string, description: string | null, kind: string, subject_kind: string, scale_id: string, scale_name: string, scoring: string, pass_score: string, items: Item[], is_active: boolean, is_locked: boolean, runs: number, frequency: { timesPerWeek: number } | null, critical_fail_rule: string, who_can_run: { roles: string[] }, require_signature?: boolean, allow_skip: boolean, allow_item_comment: boolean, item_comment_required: boolean, tags: string[], updated_at: string }
interface Crit { id: string, text: string, groupName: string }
interface Wave { id: string, title: string, checklist_id: string, checklist_title: string, starts_at: string, ends_at: string, status: string, links: number, done: number, avg_score: string | null }
interface Link { id: string, location: string, expires_at: string, used_at: string | null, score: string | null, passed: boolean | null }
const items = ref<CL[]>([])
const scales = ref<{ id: string, name: string }[]>([])
const error = ref('')
const notice = ref('')
const editing = ref<string | null>(null)
const library = ref<Crit[]>([])
const blank = () => ({ title: '', description: '', kind: 'observation', subjectKind: 'location', scaleId: '', scoring: 'points', passScore: 80, criticalFailRule: 'any_critical_fails_all', roles: ['mentor', 'manager', 'admin'] as string[], timesPerWeek: 0, requireSignature: false, allowSkip: false, allowItemComment: true, itemCommentRequired: false, isLocked: false, isActive: true, tags: '', items: [] as Item[] })
const form = reactive(blank())
const lockedFields = ref<string[]>([])
const newItem = (c?: Crit) => ({ id: crypto.randomUUID().slice(0, 8), group: c?.groupName ?? '', text: c?.text ?? '', criterionId: c?.id, weight: 1, isCritical: false, requiresPhoto: false, hint: '', passThreshold: null as number | null })
async function load() {
  try {
    items.value = await api('/checklists'); scales.value = await api('/scales?kind=levels')
    if (!form.scaleId) form.scaleId = scales.value[0]?.id ?? ''
    const groups = await api<{ name: string, criteria: { id: string, text: string }[] }[]>('/assessment/groups').catch(() => [])
    library.value = groups.flatMap(g => g.criteria.map(c => ({ id: c.id, text: c.text, groupName: g.name })))
  }
  catch (err) { error.value = apiErrorOf(err).message }
}
onMounted(load)
function edit(c: CL) {
  editing.value = c.id; lockedFields.value = []
  Object.assign(form, { title: c.title, description: c.description ?? '', kind: c.kind, subjectKind: c.subject_kind, scaleId: c.scale_id, scoring: c.scoring, passScore: Number(c.pass_score), criticalFailRule: c.critical_fail_rule, roles: [...c.who_can_run.roles], timesPerWeek: c.frequency?.timesPerWeek ?? 0, requireSignature: c.require_signature ?? false, allowSkip: c.allow_skip, allowItemComment: c.allow_item_comment, itemCommentRequired: c.item_comment_required, isLocked: c.is_locked, isActive: c.is_active, tags: c.tags.join(', '), items: c.items.map(i => ({ ...i, group: i.group ?? '', hint: i.hint ?? '', isCritical: i.isCritical ?? false, requiresPhoto: i.requiresPhoto ?? false, passThreshold: i.passThreshold ?? null })) })
}
function reset() { editing.value = null; lockedFields.value = []; Object.assign(form, blank()); form.scaleId = scales.value[0]?.id ?? '' }
function body(extra: Record<string, unknown> = {}) {
  return {
    id: editing.value ?? undefined, title: form.title, description: form.description || null, kind: form.kind, subjectKind: form.subjectKind, scaleId: form.scaleId, scoring: form.scoring, passScore: form.passScore, criticalFailRule: form.criticalFailRule,
    whoCanRun: { roles: form.roles }, frequency: form.timesPerWeek ? { timesPerWeek: form.timesPerWeek } : null, requireSignature: form.requireSignature, allowSkip: form.allowSkip, allowItemComment: form.allowItemComment, itemCommentRequired: form.allowItemComment && form.itemCommentRequired,
    tags: form.tags.split(',').map(x => x.trim()).filter(Boolean), isActive: form.isActive,
    items: form.items.filter(i => i.text.trim()).map(i => ({ ...i, group: i.group || undefined, hint: i.hint || undefined, passThreshold: i.passThreshold || undefined })), ...extra,
  }
}
async function save() {
  error.value = ''; notice.value = ''; lockedFields.value = []
  try { await api('/checklists', { method: 'PUT', body: body() }); notice.value = t('common.saved'); reset(); await load() }
  catch (err) { const e = apiErrorOf(err); error.value = e.message; lockedFields.value = (e.details?.fields as string[] | undefined) ?? [] }
}
const fmtDate = (d: string) => new Date(d).toLocaleDateString('uk')
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
async function toggle(c: CL) {
  try {
    await api('/checklists', { method: 'PUT', body: { id: c.id, title: c.title, description: c.description, kind: c.kind, subjectKind: c.subject_kind, scaleId: c.scale_id, scoring: c.scoring, passScore: Number(c.pass_score), criticalFailRule: c.critical_fail_rule, whoCanRun: c.who_can_run, frequency: c.frequency, requireSignature: c.require_signature, allowSkip: c.allow_skip, allowItemComment: c.allow_item_comment, itemCommentRequired: c.item_comment_required, tags: c.tags, items: c.items, isActive: !c.is_active } })
    await load()
  }
  catch (err) { error.value = apiErrorOf(err).message }
}
</script>
<template>
  <div>
    <PageHeader :title="t('admin.nav.checklists')" :crumbs="[{ label: t('assess.sectionTitle') }]">
      <template #actions><button class="btn primary" @click="reset(); notice = ''">{{ t('cl.create') }}</button></template>
    </PageHeader>
    <p class="note sun">{{ t('cl.weightVsNorm') }}</p>
    <p v-if="error" class="note coral">{{ error }}<span v-if="lockedFields.length" class="sub"> ({{ lockedFields.join(', ') }})</span></p>
    <p v-if="notice" class="note teal">{{ notice }}</p>
    <div class="table-wrap">
      <table class="table">
        <thead><tr><th>{{ t('assess.col.title') }}</th><th class="num">{{ t('cl.col.items') }}</th><th>{{ t('assess.col.scale') }}</th><th>{{ t('cl.col.scoring') }}</th><th>{{ t('assess.col.updated') }}</th><th>{{ t('assess.col.published') }}</th><th /></tr></thead>
        <tbody>
          <tr v-for="c in items" :key="c.id" :class="{ off: !c.is_active }">
            <td><b>{{ c.title }}</b><span class="sub">{{ t(`cl.kind.${c.kind}`) }} · {{ t(`cl.subject.${c.subject_kind}`) }} · {{ t('cl.runs') }}: {{ c.runs }}<template v-if="c.is_locked"> · {{ t('assess.lockedShort') }}</template></span></td>
            <td class="num">{{ c.items.length }}</td><td>{{ c.scale_name }}</td><td>{{ t(`cl.scoringLabel.${c.scoring}`) }}</td><td>{{ fmtDate(c.updated_at) }}</td>
            <td><span :class="['badge', c.is_active ? 'teal' : 'muted']">{{ c.is_active ? t('common.yes') : t('common.no') }}</span></td>
            <td class="acts"><button class="chip" @click="edit(c)">{{ t('common.edit') }}</button><button class="chip" @click="toggle(c)">{{ c.is_active ? t('common.deactivate') : t('common.activate') }}</button></td>
          </tr>
        </tbody>
      </table>
    </div>
    <section class="card">
      <h2>{{ editing ? t('common.edit') : t('cl.new') }}</h2>
      <p v-if="form.isLocked" class="note coral" data-testid="cl-locked">{{ t('cl.lockedBanner') }}</p>
      <div class="row">
        <input v-model="form.title" class="field grow" :placeholder="t('cl.titleHint')" data-testid="cl-title">
        <select v-model="form.kind" class="field" :disabled="form.isLocked"><option v-for="k in ['observation', 'audit', 'mystery']" :key="k" :value="k">{{ t(`cl.kind.${k}`) }}</option></select>
        <select v-model="form.subjectKind" class="field" :disabled="form.isLocked"><option v-for="k in ['location', 'user', 'shift']" :key="k" :value="k">{{ t(`cl.subject.${k}`) }}</option></select>
        <label class="sub">{{ t('assess.scaleField') }} <select v-model="form.scaleId" class="field" :disabled="form.isLocked" data-testid="cl-scale"><option v-for="s in scales" :key="s.id" :value="s.id">{{ s.name }}</option></select></label>
      </div>
      <textarea v-model="form.description" class="field" rows="2" :placeholder="t('assess.description')" />
      <div class="row">
        <select v-model="form.scoring" class="field" :disabled="form.isLocked"><option value="percent">{{ t('cl.scoring.percent') }}</option><option value="points">{{ t('cl.scoring.points') }}</option><option value="pass_fail">{{ t('cl.scoring.pass_fail') }}</option></select>
        <label class="sub">{{ t('cl.passScore') }} <input v-model.number="form.passScore" class="field short" type="number" min="1" max="100" :disabled="form.isLocked"></label>
        <label class="check"><input v-model="form.criticalFailRule" type="checkbox" true-value="any_critical_fails_all" false-value="none" :disabled="form.isLocked"> {{ t('cl.criticalRule') }}</label>
        <label class="sub">{{ t('cl.timesPerWeek') }} <input v-model.number="form.timesPerWeek" class="field short" type="number" min="0" max="50"></label>
      </div>
      <div class="row">
        <label class="check"><input v-model="form.allowSkip" type="checkbox" :disabled="form.isLocked"> {{ t('cl.allowSkip') }}</label>
        <label class="check"><input v-model="form.allowItemComment" type="checkbox" :disabled="form.isLocked"> {{ t('cl.allowItemComment') }}</label>
        <label v-if="form.allowItemComment" class="check"><input v-model="form.itemCommentRequired" type="checkbox" :disabled="form.isLocked"> {{ t('assess.makeRequired') }}</label>
        <label class="check"><input v-model="form.requireSignature" type="checkbox" :disabled="form.isLocked"> {{ t('cl.requireSignature') }}</label>
        <label class="check"><input v-model="form.isActive" type="checkbox"> {{ t('assess.published') }}</label>
      </div>
      <div class="row"><span class="sub">{{ t('cl.whoCanRun') }}:</span><label v-for="r in ['mentor', 'manager', 'author', 'admin']" :key="r" class="check"><input v-model="form.roles" type="checkbox" :value="r"> {{ r }}</label></div>
      <input v-model="form.tags" class="field" :placeholder="t('assess.tagsHint')">
      <h3>{{ t('cl.items') }} <span class="sub">— {{ t('assess.criterionIndicator') }} · {{ t('assess.weight') }}</span></h3>
      <div v-for="(it, i) in form.items" :key="it.id" class="row item">
        <input v-model="it.group" class="field" :placeholder="t('cl.group')" :disabled="form.isLocked">
        <input v-model="it.text" class="field grow" :placeholder="t('cl.itemText')" :data-testid="`item-text-${i}`" :disabled="form.isLocked">
        <label class="sub">{{ t('assess.weight') }}<input v-model.number="it.weight" class="field short" type="number" step="0.5" min="0.1" :disabled="form.isLocked"></label>
        <label class="check" :title="t('cl.criticalHint')"><input v-model="it.isCritical" type="checkbox" :disabled="form.isLocked"> {{ t('cl.critical') }}</label>
        <label class="check"><input v-model="it.requiresPhoto" type="checkbox" :disabled="form.isLocked"> {{ t('cl.photoRequired') }}</label>
        <label class="sub" :title="t('cl.itemThresholdHint')">{{ t('cl.itemThreshold') }}<input v-model.number="it.passThreshold" class="field short" type="number" min="1" max="100" :placeholder="String(form.passScore)" :disabled="form.isLocked"></label>
        <input v-model="it.hint" class="field grow" :placeholder="t('cl.hint')" maxlength="300">
        <button class="chip" :disabled="form.isLocked" :aria-label="t('common.delete')" @click="form.items.splice(i, 1)">✕</button>
      </div>
      <div class="row">
        <button class="chip" data-testid="item-add" :disabled="form.isLocked" @click="form.items.push(newItem())">+ {{ t('cl.item') }}</button>
        <select v-if="library.length" class="field" :disabled="form.isLocked" :aria-label="t('cl.fromLibrary')" @change="form.items.push(newItem(library.find(c => c.id === ($event.target as HTMLSelectElement).value))); ($event.target as HTMLSelectElement).value = ''">
          <option value="">{{ t('cl.fromLibrary') }}</option><option v-for="c in library" :key="c.id" :value="c.id">{{ c.text }} — {{ c.groupName }}</option>
        </select>
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
h2, h3 { margin: 0; font-weight: 800; }
tr.off { opacity: 0.5; }
.note { margin: 0 0 var(--space-3); }
.acts { display: flex; gap: var(--space-1); }
.card { display: grid; gap: var(--space-3); margin-top: var(--space-4); }
.field { width: auto; }
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
