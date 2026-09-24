<script setup lang="ts">
const { formatShortDate } = useFormat()
definePageMeta({ layout: 'admin', middleware: 'admin-scope', requiredScope: 'development.team' })
const { t } = useI18n()
const { api } = useApi()
interface Cell { competencyId: string, current: number, required: number, currentLabel: string, requiredLabel: string, gap: number, isCritical: boolean, color: 'teal' | 'sun' | 'coral', source: string | null }
interface Row { userId: string, fullName: string, position: string, location: string, hasProfile: boolean, cells: Cell[], fits: boolean }
interface M { columns: { id: string, name: string, kind: string }[], rows: Row[], displayAs: 'label' | 'value', summary: { people: number, withProfile: number, fit: number, fitPct: number | null } }
interface Hist { competency: { name: string, levels: { level: number, title: string, behavior: string }[] } | null, history: { id: string, level: number, levelLabel: string, source: string, assessed_at: string, comment: string | null, assessed_by: string | null }[], whatToLearn: { id: string, title: string }[], displayAs: 'label' | 'value' }
const m = ref<M | null>(null)
const locations = ref<{ id: string, name: string }[]>([])
const locationId = ref('')
const error = ref('')
const picked = ref<{ row: Row, cell: Cell, hist: Hist | null } | null>(null)
async function load() {
  try { m.value = await api('/competency-matrix', { query: locationId.value ? { locationId: locationId.value } : {} }) }
  catch (err) { error.value = apiErrorOf(err).message }
}
onMounted(async () => { load(); try { locations.value = await api('/refs/locations') } catch { /* фильтр пустой */ } })
watch(locationId, load)
async function open(row: Row, cell: Cell) {
  picked.value = { row, cell, hist: null }
  try { picked.value.hist = await api('/competency-matrix/history', { query: { userId: row.userId, competencyId: cell.competencyId } }) }
  catch (err) { error.value = apiErrorOf(err).message }
}
const cellOf = (row: Row, compId: string) => row.cells.find(c => c.competencyId === compId)
const fmt = (d: string) => formatShortDate(new Date(d))
const asLabel = (v: number, label: string) => m.value?.displayAs === 'label' ? label : String(v)
</script>
<template>
  <div>
    <header class="head">
      <h1>{{ t('dev.matrix') }}</h1>
      <select v-model="locationId" class="field" :aria-label="t('person.location')"><option value="">{{ t('dev.allLocations') }}</option><option v-for="l in locations" :key="l.id" :value="l.id">{{ l.name }}</option></select>
    </header>
    <p v-if="error" class="error" role="alert">{{ error }}</p>
    <template v-if="m">
      <div class="tiles">
        <div class="tile"><b>{{ m.summary.people }}</b><span>{{ t('dev.peopleTile') }}</span></div>
        <div class="tile"><b>{{ m.summary.withProfile }}</b><span>{{ t('dev.withProfile') }}</span></div>
        <div class="tile teal"><b>{{ m.summary.fitPct ?? '—' }}%</b><span>{{ t('dev.fitProfile') }}</span></div>
      </div>
      <p class="legend"><span class="sw teal" /> {{ t('dev.legendFit') }} <span class="sw sun" /> {{ t('dev.legendMinus1') }} <span class="sw coral" /> {{ t('dev.legendMinus2') }}</p>
      <div class="table-wrap">
        <table class="table">
          <thead><tr><th>{{ t('people.col.name') }}</th><th v-for="c in m.columns" :key="c.id" class="col">{{ c.name }}</th></tr></thead>
          <tbody>
            <tr v-for="r in m.rows" :key="r.userId">
              <td><b>{{ r.fullName }}</b><div class="sub">{{ r.position }} · {{ r.location }}</div><div v-if="!r.hasProfile" class="sub">{{ t('dev.noProfileShort') }}</div></td>
              <td v-for="c in m.columns" :key="c.id" class="cellwrap">
                <button v-if="cellOf(r, c.id)" :class="['cell', cellOf(r, c.id)!.color, { crit: cellOf(r, c.id)!.isCritical }]" :aria-label="`${r.fullName}: ${c.name} ${asLabel(cellOf(r, c.id)!.current, cellOf(r, c.id)!.currentLabel)}/${asLabel(cellOf(r, c.id)!.required, cellOf(r, c.id)!.requiredLabel)}`" @click="open(r, cellOf(r, c.id)!)">
                  {{ asLabel(cellOf(r, c.id)!.current, cellOf(r, c.id)!.currentLabel) }}<span class="req">/{{ asLabel(cellOf(r, c.id)!.required, cellOf(r, c.id)!.requiredLabel) }}</span>
                </button>
                <span v-else class="sub">·</span>
              </td>
            </tr>
          </tbody>
        </table>
      </div>
    </template>
    <div v-if="picked" class="overlay" @click.self="picked = null">
      <section class="modal" role="dialog" aria-modal="true">
        <h2>{{ picked.row.fullName }} · {{ picked.hist?.competency?.name ?? '' }}</h2>
        <p class="sub">{{ t('dev.levelNow') }}: <b>{{ asLabel(picked.cell.current, picked.cell.currentLabel) }}</b> / {{ t('dev.levelRequired') }}: <b>{{ asLabel(picked.cell.required, picked.cell.requiredLabel) }}</b><template v-if="picked.cell.gap"> · {{ t('dev.gapN', { n: picked.cell.gap }) }}</template></p>
        <template v-if="picked.hist">
          <h3>{{ t('dev.history') }}</h3>
          <ul class="list">
            <li v-for="h in picked.hist.history" :key="h.id"><b>{{ t('dev.level') }} {{ picked.hist.displayAs === 'label' ? h.levelLabel : h.level }}</b> <span class="sub">{{ t(`dev.source.${h.source}`, h.source) }} · {{ fmt(h.assessed_at) }}{{ h.assessed_by ? ` · ${h.assessed_by}` : '' }}</span><div v-if="h.comment" class="sub">{{ h.comment }}</div></li>
            <li v-if="picked.hist.history.length === 0" class="sub">{{ t('person.noData') }}</li>
          </ul>
          <h3 v-if="picked.hist.whatToLearn.length">{{ t('dev.whatToLearn') }}</h3>
          <ul class="list"><li v-for="c in picked.hist.whatToLearn" :key="c.id"><NuxtLink :to="`/admin/courses/${c.id}`" class="link">{{ c.title }}</NuxtLink></li></ul>
        </template>
        <button class="chip" @click="picked = null">{{ t('common.back') }}</button>
      </section>
    </div>
  </div>
</template>
<style scoped>
.head { display: flex; align-items: center; gap: var(--space-3); margin-bottom: var(--space-3); flex-wrap: wrap; }
h1 { margin: 0; font-weight: 900; }
h2 { margin: 0; font-weight: 800; }
h3 { margin: var(--space-2) 0 0; font-size: var(--font-size-body); color: var(--color-ink-muted); }
.field { font: inherit; border: 1px solid var(--color-bg-line); border-radius: var(--radius-s); padding: var(--space-2) var(--space-3); background: var(--color-bg); color: var(--color-ink); }
.tiles { display: flex; gap: var(--space-3); flex-wrap: wrap; margin-bottom: var(--space-3); }
.tile { background: var(--color-bg-soft); border-radius: var(--radius-m); padding: var(--space-3) var(--space-5); display: grid; text-align: center; }
.tile b { font-size: var(--font-size-title-l); font-weight: 900; }
.tile span { font-size: var(--font-size-body-s); color: var(--color-ink-muted); }
.tile.teal b { color: var(--color-teal-ink); }
.legend { display: flex; gap: var(--space-2); align-items: center; font-size: var(--font-size-body-s); color: var(--color-ink-muted); flex-wrap: wrap; }
.sw { width: 14px; height: 14px; border-radius: var(--radius-s); display: inline-block; }
.sw.teal, .cell.teal { background: var(--color-teal); color: var(--color-teal-deep); }
.sw.sun, .cell.sun { background: var(--color-sun); color: var(--color-sun-ink); }
.sw.coral, .cell.coral { background: var(--color-coral); color: var(--color-coral-deep); }
.table-wrap { overflow-x: auto; }
.table { border-collapse: collapse; background: var(--color-bg-soft); border-radius: var(--radius-m); overflow: hidden; min-width: 100%; }
th { text-align: left; font-size: var(--font-size-body-s); color: var(--color-ink-muted); padding: var(--space-2) var(--space-3); border-bottom: 1px solid var(--color-bg-line); }
th.col { max-width: 140px; white-space: normal; }
td { padding: var(--space-2) var(--space-3); border-bottom: 1px solid var(--color-bg-line-soft); vertical-align: top; }
.cellwrap { text-align: center; }
.cell { font: inherit; font-weight: 900; border: none; border-radius: var(--radius-s); padding: var(--space-1) var(--space-2); cursor: pointer; min-width: 44px; }
.cell.crit { outline: 2px solid var(--color-ink); }
.req { font-weight: 400; opacity: 0.7; }
.sub { font-size: var(--font-size-body-s); color: var(--color-ink-faint); }
.error { color: var(--color-coral-ink); }
.list { list-style: none; margin: 0; padding: 0; display: grid; gap: var(--space-1); }
.link { color: var(--color-teal-ink); font-weight: 700; text-decoration: none; }
.chip { font: inherit; font-size: var(--font-size-body-s); font-weight: 700; border: 1px solid var(--color-bg-line); background: transparent; color: var(--color-ink-muted); border-radius: var(--radius-pill); padding: var(--space-1) var(--space-3); cursor: pointer; justify-self: start; }
.overlay { position: fixed; inset: 0; background: rgb(0 0 0 / 40%); display: grid; place-items: center; padding: var(--space-3); z-index: 20; }
.modal { background: var(--color-bg-soft); border-radius: var(--radius-l); padding: var(--space-4); display: grid; gap: var(--space-2); width: min(520px, 100%); box-sizing: border-box; max-height: 100%; overflow: auto; }
</style>
