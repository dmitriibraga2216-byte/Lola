<script setup lang="ts">
definePageMeta({ layout: 'admin', middleware: 'admin-scope', requiredScope: 'checklist.manage' })
const { t } = useI18n()
const { api } = useApi()
interface Item { id: string, group?: string, text: string, scaleId: string, weight: number, isCritical?: boolean, requiresPhoto?: boolean, hint?: string }
interface CL { id: string, title: string, kind: string, subject_kind: string, scoring: string, pass_score: string, items: Item[], is_active: boolean, runs: number, frequency: { timesPerWeek: number } | null, critical_fail_rule: string, who_can_run: { roles: string[] } }
const items = ref<CL[]>([])
const scales = ref<{ id: string, name: string }[]>([])
const error = ref('')
const notice = ref('')
const editing = ref<string | null>(null)
const blank = () => ({ title: '', kind: 'observation', subjectKind: 'location', scoring: 'percent', passScore: 80, criticalFailRule: 'any_critical_fails_all', roles: ['mentor', 'manager', 'admin'] as string[], timesPerWeek: 0, items: [] as Item[] })
const form = reactive(blank())
const newItem = () => ({ id: crypto.randomUUID().slice(0, 8), group: '', text: '', scaleId: scales.value[0]?.id ?? '', weight: 1, isCritical: false, requiresPhoto: false, hint: '' })
async function load() { try { items.value = await api('/checklists'); scales.value = await api('/rating-scales') } catch (err) { error.value = apiErrorOf(err).message } }
onMounted(load)
function edit(c: CL) { editing.value = c.id; Object.assign(form, { title: c.title, kind: c.kind, subjectKind: c.subject_kind, scoring: c.scoring, passScore: Number(c.pass_score), criticalFailRule: c.critical_fail_rule, roles: [...c.who_can_run.roles], timesPerWeek: c.frequency?.timesPerWeek ?? 0, items: c.items.map(i => ({ ...i, group: i.group ?? '', hint: i.hint ?? '', isCritical: i.isCritical ?? false, requiresPhoto: i.requiresPhoto ?? false })) }) }
function reset() { editing.value = null; Object.assign(form, blank()) }
async function save() {
  error.value = ''; notice.value = ''
  try {
    await api('/checklists', { method: 'PUT', body: { id: editing.value ?? undefined, title: form.title, kind: form.kind, subjectKind: form.subjectKind, scoring: form.scoring, passScore: form.passScore, criticalFailRule: form.criticalFailRule, whoCanRun: { roles: form.roles }, frequency: form.timesPerWeek ? { timesPerWeek: form.timesPerWeek } : null, items: form.items.filter(i => i.text.trim()).map(i => ({ ...i, group: i.group || undefined, hint: i.hint || undefined })) } })
    notice.value = t('common.saved'); reset(); await load()
  } catch (err) { error.value = apiErrorOf(err).message }
}
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
</style>
