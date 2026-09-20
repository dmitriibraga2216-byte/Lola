<script setup lang="ts">
/**
 * Шкали оцінювання (мокап Scales, docs/24 Г-24.4): чипы «Шкали завдань» (range — диапазоны процентов)
 * и «Шкали анкет» (levels — перечень уровней); карточки шкал, форма в панели.
 */
definePageMeta({ layout: 'admin', middleware: 'admin-scope', requiredScope: 'settings.tenant' })
const { t } = useI18n()
const { api } = useApi()

interface Level { label: string, value: number | null, rangeFrom: number | null, rangeTo: number | null, characteristic: string | null, showInReports: boolean }
interface Scale { id: string, name: string, description: string | null, kind: 'range' | 'levels', displayAs: 'label' | 'value' | null, levels: Level[] }

const scales = ref<Scale[]>([])
const kind = ref<'range' | 'levels'>('range')
const editing = ref<Scale | null>(null)
const creating = ref(false)
const form = reactive<{ name: string, description: string, kind: 'range' | 'levels', displayAs: 'label' | 'value', levels: Level[] }>({ name: '', description: '', kind: 'range', displayAs: 'label', levels: [] })
const error = ref('')

async function load() { scales.value = await api<Scale[]>('/scales') }
onMounted(load)
const list = computed(() => scales.value.filter(s => s.kind === kind.value))
const count = (k: string) => scales.value.filter(s => s.kind === k).length

function blank(k: 'range' | 'levels'): Level[] {
  return k === 'range'
    ? [{ label: '', value: null, rangeFrom: 0, rangeTo: 59, characteristic: '', showInReports: true }, { label: '', value: null, rangeFrom: 60, rangeTo: 84, characteristic: '', showInReports: true }, { label: '', value: null, rangeFrom: 85, rangeTo: 100, characteristic: '', showInReports: true }]
    : [1, 2, 3, 4, 5].map(v => ({ label: '', value: v, rangeFrom: null, rangeTo: null, characteristic: '', showInReports: true }))
}
function startCreate() {
  creating.value = true; editing.value = null; error.value = ''
  Object.assign(form, { name: '', description: '', kind: kind.value, displayAs: 'label', levels: blank(kind.value) })
}
function edit(s: Scale) {
  editing.value = s; creating.value = false; error.value = ''
  Object.assign(form, { name: s.name, description: s.description ?? '', kind: s.kind, displayAs: s.displayAs ?? 'label', levels: s.levels.map(l => ({ ...l, characteristic: l.characteristic ?? '' })) })
}
function addLevel() {
  const last = form.levels[form.levels.length - 1]
  form.levels.push(form.kind === 'range'
    ? { label: '', value: null, rangeFrom: Math.min((last?.rangeTo ?? -1) + 1, 100), rangeTo: 100, characteristic: '', showInReports: true }
    : { label: '', value: (last?.value ?? 0) + 1, rangeFrom: null, rangeTo: null, characteristic: '', showInReports: true })
}
async function save() {
  error.value = ''
  const body = { name: form.name, description: form.description || null, kind: form.kind, displayAs: form.kind === 'levels' ? form.displayAs : null, levels: form.levels.map(l => ({ ...l, characteristic: l.characteristic || null })) }
  try {
    if (creating.value) await api('/scales', { method: 'POST', body })
    else if (editing.value) await api(`/scales/${editing.value.id}`, { method: 'PUT', body })
    creating.value = false; editing.value = null
    await load()
  }
  catch (err) { error.value = apiErrorOf(err).message }
}
async function remove(s: Scale) {
  if (!confirm(t('settings.scales.confirmDelete', { name: s.name }))) return
  try { await api(`/scales/${s.id}`, { method: 'DELETE' }); if (editing.value?.id === s.id) editing.value = null; await load() }
  catch (err) { error.value = apiErrorOf(err).message }
}
</script>

<template>
  <div>
    <PageHeader :title="t('settings.scales.title')" :crumbs="[{ label: t('admin.section.learning') }, { label: t('admin.section.settings') }, { label: t('settings.scales.title') }]">
      <template #actions><button class="btn primary" type="button" @click="startCreate">{{ t('settings.scales.add') }}</button></template>
    </PageHeader>
    <p v-if="error" class="error-text" role="alert">{{ error }}</p>
    <div class="chips">
      <button class="chip" :class="{ on: kind === 'range' }" type="button" @click="kind = 'range'">{{ t('settings.scales.tasks') }} · {{ count('range') }}</button>
      <button class="chip" :class="{ on: kind === 'levels' }" type="button" @click="kind = 'levels'">{{ t('settings.scales.forms') }} · {{ count('levels') }}</button>
    </div>

    <div class="layout">
      <div class="cards">
        <p v-if="!list.length" class="muted">{{ t('settings.scales.empty') }}</p>
        <article v-for="s in list" :key="s.id" class="card scale">
          <header>
            <b>{{ s.name }}</b> <span class="muted">· {{ s.kind === 'range' ? t('settings.scales.kindRange') : t('settings.scales.kindLevels') }}</span>
            <span class="spacer" />
            <button class="btn ghost small" type="button" @click="edit(s)">{{ t('common.edit') }}</button>
            <button class="btn ghost small" type="button" @click="remove(s)">{{ t('common.delete') }}</button>
          </header>
          <ul class="levels">
            <li v-for="l in s.levels" :key="l.label + String(l.value)">
              <span class="val">{{ s.kind === 'range' ? `${l.rangeFrom}—${l.rangeTo}` : l.value }}</span>
              <span><b>{{ l.label }}</b><span v-if="l.characteristic" class="muted"> · {{ l.characteristic }}</span></span>
              <span v-if="!l.showInReports" class="badge muted">{{ t('settings.scales.hiddenInReports') }}</span>
            </li>
          </ul>
        </article>
      </div>

      <aside v-if="creating || editing" class="card editor">
        <h2 class="panel-title">{{ creating ? t('settings.scales.new') : form.name }}</h2>
        <label class="label" for="sc-name">{{ t('settings.scales.name') }}</label><input id="sc-name" v-model="form.name" class="field" maxlength="100">
        <label class="label top" for="sc-desc">{{ t('settings.scales.description') }}</label><input id="sc-desc" v-model="form.description" class="field" maxlength="500">
        <p class="label top">{{ t('settings.scales.kind') }}</p>
        <div class="segmented">
          <button type="button" :class="{ on: form.kind === 'range' }" :disabled="!creating" @click="form.kind = 'range'; form.levels = blank('range')">{{ t('settings.scales.kindRange') }}</button>
          <button type="button" :class="{ on: form.kind === 'levels' }" :disabled="!creating" @click="form.kind = 'levels'; form.levels = blank('levels')">{{ t('settings.scales.kindLevels') }}</button>
        </div>
        <template v-if="form.kind === 'levels'">
          <p class="label top">{{ t('settings.scales.displayAs') }}</p>
          <div class="segmented">
            <button type="button" :class="{ on: form.displayAs === 'label' }" @click="form.displayAs = 'label'">{{ t('settings.scales.displayLabel') }}</button>
            <button type="button" :class="{ on: form.displayAs === 'value' }" @click="form.displayAs = 'value'">{{ t('settings.scales.displayValue') }}</button>
          </div>
        </template>
        <p class="label top">{{ t('settings.scales.levels') }}</p>
        <p class="help">{{ form.kind === 'range' ? t('settings.scales.rangeHint') : t('settings.scales.levelsHint') }}</p>
        <div v-for="(l, i) in form.levels" :key="i" class="lvl">
          <template v-if="form.kind === 'range'">
            <input v-model.number="l.rangeFrom" class="field n" type="number" min="0" max="100" :aria-label="t('settings.scales.from')">
            <input v-model.number="l.rangeTo" class="field n" type="number" min="0" max="100" :aria-label="t('settings.scales.to')">
          </template>
          <input v-else v-model.number="l.value" class="field n" type="number" :aria-label="t('settings.scales.value')">
          <input v-model="l.label" class="field" maxlength="80" :placeholder="t('settings.scales.label')" :aria-label="t('settings.scales.label')">
          <input v-model="l.characteristic" class="field" maxlength="300" :placeholder="t('settings.scales.characteristic')" :aria-label="t('settings.scales.characteristic')">
          <label class="toggle small"><input v-model="l.showInReports" type="checkbox"><span>{{ t('settings.scales.inReports') }}</span></label>
          <button class="btn ghost small" type="button" :aria-label="t('common.delete')" :disabled="form.levels.length <= 2" @click="form.levels.splice(i, 1)">×</button>
        </div>
        <div class="actions">
          <button class="btn ghost small" type="button" @click="addLevel">{{ t('settings.scales.addLevel') }}</button>
          <span class="spacer" />
          <button class="btn ghost" type="button" @click="creating = false; editing = null">{{ t('common.cancel') }}</button>
          <button class="btn primary" type="button" :disabled="!form.name || form.levels.some(l => !l.label)" @click="save">{{ t('common.save') }}</button>
        </div>
      </aside>
    </div>
  </div>
</template>

<style scoped>
.layout { display: grid; grid-template-columns: minmax(0, 1fr) minmax(320px, 520px); gap: var(--space-4); align-items: start; margin-top: var(--space-4); }
.cards { display: grid; gap: var(--space-3); }
.scale header { display: flex; gap: var(--space-2); align-items: center; margin-bottom: var(--space-2); flex-wrap: wrap; }
.spacer { flex: 1; }
.levels { list-style: none; margin: 0; padding: 0; display: grid; gap: var(--space-1); }
.levels li { display: grid; grid-template-columns: 80px 1fr auto; gap: var(--space-2); align-items: center; }
.val { font-weight: 900; color: var(--color-teal-ink); }
.editor { display: grid; gap: var(--space-2); }
.top { margin-top: var(--space-3); }
.lvl { display: grid; grid-template-columns: 64px 64px 1fr 1fr auto auto; gap: var(--space-1); align-items: center; }
.lvl .n { padding-left: var(--space-2); padding-right: var(--space-2); }
.toggle.small { font-size: var(--font-size-body-s); }
.actions { display: flex; gap: var(--space-2); align-items: center; margin-top: var(--space-2); flex-wrap: wrap; }
@media (max-width: 900px) { .layout { grid-template-columns: 1fr; } .lvl { grid-template-columns: 1fr 1fr; } }
</style>
