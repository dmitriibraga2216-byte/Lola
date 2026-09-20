<script setup lang="ts">
definePageMeta({ layout: 'admin', middleware: 'admin-scope', requiredScope: 'report.builder' })
const { t } = useI18n()
const { api } = useApi()
const route = useRoute()
interface Saved { id: string, name: string, entity: string, fields: string[], filters: Record<string, unknown>, groupBy: string | null, schedule: { every: string, hour: number, weekday?: number, channel: string, recipients: string[] } | null, lastRunAt: string | null, author: string | null }
const meta = ref<{ entities: Record<string, { fields: string[], filters: string[] }>, saved: Saved[] } | null>(null)
const rows = ref<Record<string, unknown>[]>([])
const people = ref<{ id: string, fullName: string }[]>([])
const locations = ref<{ id: string, name: string }[]>([])
const error = ref('')
const notice = ref('')
const editingId = ref<string | null>(null)
const spec = reactive({ entity: 'people', fields: ['full_name', 'location', 'position'] as string[], filters: {} as Record<string, string>, groupBy: '' })
const save = reactive({ name: '', scheduled: false, every: 'daily', hour: 9, weekday: 1, channel: 'telegram', recipients: [] as string[] })
async function load() {
  try { meta.value = await api('/reports/builder'); people.value = await api('/people?limit=100'); locations.value = await api('/refs/locations') } catch (err) { error.value = apiErrorOf(err).message }
  const id = route.query.saved as string | undefined
  if (id) { const s = meta.value?.saved.find(x => x.id === id); if (s) pick(s) }
}
onMounted(load)
function pick(s: Saved) { editingId.value = s.id; Object.assign(spec, { entity: s.entity, fields: [...s.fields], filters: Object.fromEntries(Object.entries(s.filters).map(([k, v]) => [k, String(v ?? '')])), groupBy: s.groupBy ?? '' }); Object.assign(save, { name: s.name, scheduled: !!s.schedule, every: s.schedule?.every ?? 'daily', hour: s.schedule?.hour ?? 9, weekday: s.schedule?.weekday ?? 1, channel: s.schedule?.channel ?? 'telegram', recipients: s.schedule?.recipients ?? [] }); run() }
watch(() => spec.entity, () => { spec.fields = meta.value?.entities[spec.entity]?.fields.slice(0, 3) ?? []; spec.filters = {}; spec.groupBy = '' })
const cleanFilters = () => Object.fromEntries(Object.entries(spec.filters).filter(([, v]) => v !== ''))
async function run() {
  error.value = ''
  try { rows.value = await api('/reports/builder/run', { method: 'POST', body: { entity: spec.entity, fields: spec.fields, filters: cleanFilters(), groupBy: spec.groupBy || null } }) } catch (err) { error.value = apiErrorOf(err).message }
}
async function persist() {
  error.value = ''; notice.value = ''
  try {
    await api('/reports/builder', { method: 'PUT', body: { id: editingId.value ?? undefined, name: save.name, spec: { entity: spec.entity, fields: spec.fields, filters: cleanFilters(), groupBy: spec.groupBy || null }, schedule: save.scheduled ? { every: save.every, hour: save.hour, weekday: save.every === 'weekly' ? save.weekday : undefined, channel: save.channel, recipients: save.recipients } : null } })
    notice.value = t('common.saved'); await load()
  } catch (err) { error.value = apiErrorOf(err).message }
}
async function remove(s: Saved) { await api(`/reports/builder/${s.id}`, { method: 'DELETE' }); if (editingId.value === s.id) editingId.value = null; await load() }
const cols = computed(() => rows.value.length ? Object.keys(rows.value[0]!) : [])
const fmt = (v: unknown) => v == null ? '—' : typeof v === 'boolean' ? (v ? '✓' : '✕') : /^\d{4}-\d{2}-\d{2}T/.test(String(v)) ? new Date(String(v)).toLocaleDateString('uk-UA') : String(v)
</script>
<template>
  <div>
    <h1>{{ t('admin.nav.reportBuilder') }}</h1>
    <p v-if="error" class="error">{{ error }}</p>
    <p v-if="notice" class="notice">{{ notice }}</p>
    <div class="layout">
      <aside class="card">
        <h2>{{ t('rb.saved') }}</h2>
        <button v-for="s in meta?.saved ?? []" :key="s.id" :class="['item', { on: editingId === s.id }]" @click="pick(s)">
          <b>{{ s.name }}</b><span class="sub">{{ t(`rb.entity.${s.entity}`) }} · {{ t('rb.origin') }}<template v-if="s.schedule"> · {{ t('rb.scheduled') }} {{ s.schedule.every === 'daily' ? t('rb.daily') : t('rb.weekly') }} {{ s.schedule.hour }}:00</template></span>
          <span class="acts"><a :href="`/api/v1/reports/builder/${s.id}/xlsx`" class="mini" @click.stop>xlsx</a><button class="mini" @click.stop="remove(s)">✕</button></span>
        </button>
        <p v-if="!meta?.saved.length" class="sub">{{ t('rb.noSaved') }}</p>
        <button class="chip" @click="editingId = null; save.name = ''">+ {{ t('rb.new') }}</button>
      </aside>
      <section class="card main">
        <div class="row">
          <select v-model="spec.entity" class="field"><option v-for="(_, e) in meta?.entities ?? {}" :key="e" :value="e">{{ t(`rb.entity.${e}`) }}</option></select>
          <span class="sub">{{ t('rb.groupBy') }}</span>
          <select v-model="spec.groupBy" class="field"><option value="">—</option><option v-for="f in meta?.entities[spec.entity]?.fields ?? []" :key="f" :value="f">{{ t(`rb.field.${f}`) }}</option></select>
        </div>
        <div class="row"><span class="sub">{{ t('rb.fields') }}:</span><label v-for="f in meta?.entities[spec.entity]?.fields ?? []" :key="f" class="check"><input v-model="spec.fields" type="checkbox" :value="f"> {{ t(`rb.field.${f}`) }}</label></div>
        <div class="row">
          <span class="sub">{{ t('rb.filters') }}:</span>
          <template v-for="f in meta?.entities[spec.entity]?.filters ?? []" :key="f">
            <select v-if="f === 'location_id'" v-model="spec.filters[f]" class="field"><option value="">{{ t('rb.allLocations') }}</option><option v-for="l in locations" :key="l.id" :value="l.id">{{ l.name }}</option></select>
            <input v-else-if="/_from|_to|^from$|^to$/.test(f)" v-model="spec.filters[f]" class="field" type="date" :title="f">
            <input v-else v-model="spec.filters[f]" class="field short" :placeholder="f">
          </template>
        </div>
        <div class="row"><button class="primary" :disabled="!spec.fields.length" data-testid="rb-run" @click="run">{{ t('rb.run') }}</button><span class="sub">{{ rows.length }} {{ t('rb.rows') }}</span></div>
        <div class="scroll">
          <table v-if="rows.length" class="table">
            <thead><tr><th v-for="c in cols" :key="c">{{ t(`rb.field.${c}`, c) }}</th></tr></thead>
            <tbody><tr v-for="(r, i) in rows.slice(0, 200)" :key="i"><td v-for="c in cols" :key="c">{{ fmt(r[c]) }}</td></tr></tbody>
          </table>
        </div>
        <details :open="!!editingId">
          <summary class="sub">{{ t('rb.saveTitle') }}</summary>
          <div class="row"><input v-model="save.name" class="field grow" :placeholder="t('rb.name')"><label class="check"><input v-model="save.scheduled" type="checkbox"> {{ t('rb.schedule') }}</label></div>
          <div v-if="save.scheduled" class="row">
            <select v-model="save.every" class="field"><option value="daily">{{ t('rb.daily') }}</option><option value="weekly">{{ t('rb.weekly') }}</option></select>
            <select v-if="save.every === 'weekly'" v-model.number="save.weekday" class="field"><option v-for="(d, i) in ['Нд', 'Пн', 'Вт', 'Ср', 'Чт', 'Пт', 'Сб']" :key="i" :value="i">{{ d }}</option></select>
            <label class="sub">{{ t('rb.hour') }} <input v-model.number="save.hour" class="field short" type="number" min="0" max="23"></label>
            <select v-model="save.channel" class="field"><option value="telegram">Telegram</option><option value="email">E-mail</option></select>
          </div>
          <div v-if="save.scheduled" class="row"><span class="sub">{{ t('rb.recipients') }}:</span><label v-for="p in people" :key="p.id" class="check"><input v-model="save.recipients" type="checkbox" :value="p.id"> {{ p.fullName }}</label></div>
          <button class="primary" :disabled="save.name.length < 2 || !spec.fields.length || (save.scheduled && !save.recipients.length)" @click="persist">{{ t('common.save') }}</button>
        </details>
      </section>
    </div>
  </div>
</template>
<style scoped>
h1 { margin: 0 0 var(--space-3); font-weight: 900; }
h2 { margin: 0; font-weight: 800; }
.layout { display: grid; grid-template-columns: 260px 1fr; gap: var(--space-3); }
@media (max-width: 800px) { .layout { grid-template-columns: 1fr; } }
.card { background: var(--color-bg-soft); border-radius: var(--radius-l); padding: var(--space-3); display: grid; gap: var(--space-2); align-content: start; }
.item { font: inherit; text-align: left; border: 1px solid var(--color-bg-line); background: var(--color-bg); border-radius: var(--radius-m); padding: var(--space-2); cursor: pointer; display: grid; gap: 2px; color: inherit; }
.item.on { border-color: var(--color-ink); }
.acts { display: flex; gap: var(--space-1); }
.mini { font: inherit; font-size: 11px; border: 1px solid var(--color-bg-line); background: transparent; border-radius: var(--radius-pill); padding: 0 6px; cursor: pointer; color: var(--color-ink-muted); text-decoration: none; }
.row { display: flex; gap: var(--space-2); align-items: center; flex-wrap: wrap; }
.field, select { font: inherit; border: 1px solid var(--color-bg-line); border-radius: var(--radius-s); padding: var(--space-2) var(--space-3); background: var(--color-bg); color: var(--color-ink); }
.short { width: 90px; }
.grow { flex: 1; min-width: 160px; }
.check { display: flex; gap: var(--space-1); align-items: center; font-size: var(--font-size-body-s); }
.chip { font: inherit; font-size: var(--font-size-body-s); font-weight: 700; border: 1px solid var(--color-bg-line); background: transparent; color: var(--color-ink-muted); border-radius: var(--radius-pill); padding: var(--space-1) var(--space-3); cursor: pointer; }
.primary { font: inherit; font-weight: 800; border: none; background: var(--color-sun); color: var(--color-ink); border-radius: var(--radius-pill); padding: var(--space-2) var(--space-4); cursor: pointer; }
.primary:disabled { opacity: 0.5; }
.scroll { overflow: auto; max-height: 60dvh; }
.table { width: 100%; border-collapse: collapse; }
th { text-align: left; font-size: var(--font-size-body-s); color: var(--color-ink-muted); padding: var(--space-1) var(--space-2); border-bottom: 1px solid var(--color-bg-line); position: sticky; top: 0; background: var(--color-bg-soft); }
td { padding: var(--space-1) var(--space-2); border-bottom: 1px solid var(--color-bg-line-soft); white-space: nowrap; }
.sub { font-size: var(--font-size-body-s); color: var(--color-ink-faint); }
.error { color: var(--color-coral-ink); }
.notice { color: var(--color-teal-ink); }
</style>
