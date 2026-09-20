<script setup lang="ts">
definePageMeta({ layout: 'learner', middleware: 'admin-scope', requiredScope: 'checklist.run' })
const { t } = useI18n()
const { api } = useApi()
const { online, pending, syncPending, syncing } = useOfflineRuns()
interface C { id: string, title: string, kind: string, subject_kind: string, frequency: { timesPerWeek: number } | null, runs_week: number }
interface Run { id: string, status: string, started_at: string, score: string | null, passed: boolean | null, title: string, location: string | null }
const items = ref<C[]>([])
const runs = ref<Run[]>([])
const locations = ref<{ id: string, name: string }[]>([])
const error = ref('')
const picking = ref<C | null>(null)
const locationId = ref('')
const queued = ref(0)
async function load() {
  try {
    items.value = (await api<C[]>('/checklists')).filter(c => (c as unknown as { is_active: boolean }).is_active)
    runs.value = await api('/checklist-runs')
    locations.value = await api('/refs/locations')
    queued.value = pending().length
  } catch (err) { error.value = apiErrorOf(err).message }
}
onMounted(load)
watch(syncing, v => { if (!v) load() })
function start(c: C) {
  if (c.subject_kind === 'location') { picking.value = c; locationId.value = locations.value[0]?.id ?? ''; return }
  go(c.id)
}
function go(checklistId: string) {
  const key = crypto.randomUUID()
  navigateTo({ path: `/learn/checklists/run/${key}`, query: { checklistId, locationId: locationId.value || undefined, locationName: locations.value.find(l => l.id === locationId.value)?.name } })
}
const fmt = (d: string) => new Date(d).toLocaleString('uk-UA', { dateStyle: 'short', timeStyle: 'short' })
</script>
<template>
  <div>
    <h1>{{ t('cl.title') }}</h1>
    <p v-if="!online" class="offline">{{ t('cl.offline') }}</p>
    <p v-else-if="queued" class="note"><button class="chip" @click="syncPending()">{{ t('cl.syncN', { n: queued }) }}</button></p>
    <p v-if="error" class="error">{{ error }}</p>
    <div class="list">
      <button v-for="c in items" :key="c.id" class="card" :data-testid="`cl-${c.id}`" @click="start(c)">
        <span class="card-title">{{ c.title }}</span>
        <span class="sub">{{ t(`cl.kind.${c.kind}`) }}<template v-if="c.frequency"> · {{ t('cl.freq', { done: c.runs_week, norm: c.frequency.timesPerWeek }) }}</template></span>
      </button>
    </div>
    <div v-if="picking" class="modal-backdrop" @click.self="picking = null">
      <div class="modal">
        <h2>{{ picking.title }}</h2>
        <label class="sub">{{ t('cl.whichLocation') }}</label>
        <select v-model="locationId"><option v-for="l in locations" :key="l.id" :value="l.id">{{ l.name }}</option></select>
        <div class="actions"><button class="chip" @click="picking = null">{{ t('common.cancel') }}</button><button class="primary" data-testid="run-start" @click="go(picking.id)">{{ t('cl.start') }}</button></div>
      </div>
    </div>
    <h2 class="h2">{{ t('cl.myRuns') }}</h2>
    <p v-if="runs.length === 0" class="sub">{{ t('cl.noRuns') }}</p>
    <div class="list">
      <NuxtLink v-for="r in runs" :key="r.id" :to="`/learn/checklists/${r.id}`" class="card">
        <div class="row"><span class="card-title">{{ r.title }}</span><span v-if="r.status === 'finished'" :class="['badge', r.passed ? 'teal' : 'coral']">{{ Number(r.score) }}%</span><span v-else class="badge">{{ t('cl.draft') }}</span></div>
        <span class="sub">{{ r.location ?? '' }} · {{ fmt(r.started_at) }}</span>
      </NuxtLink>
    </div>
  </div>
</template>
<style scoped>
h1 { margin: 0 0 var(--space-3); font-weight: 900; }
.h2 { margin: var(--space-4) 0 var(--space-2); font-weight: 800; font-size: var(--font-size-title-l); }
.list { display: grid; gap: var(--space-2); }
.card { background: var(--color-bg-soft); border-radius: var(--radius-l); padding: var(--space-3); display: grid; gap: var(--space-1); color: inherit; text-decoration: none; text-align: left; border: none; font: inherit; cursor: pointer; }
.row { display: flex; justify-content: space-between; gap: var(--space-2); align-items: center; }
.card-title { font-weight: 800; }
.sub { color: var(--color-ink-muted); font-size: var(--font-size-body-s); }
.badge { font-size: var(--font-size-body-s); font-weight: 700; border-radius: var(--radius-pill); padding: 2px var(--space-2); background: var(--color-bg); color: var(--color-ink-muted); }
.badge.teal { background: var(--color-teal); color: var(--color-teal-deep); }
.badge.coral { background: var(--color-coral); color: var(--color-coral-deep); }
.offline { background: var(--color-sun); color: var(--color-sun-ink); padding: var(--space-2) var(--space-3); border-radius: var(--radius-m); font-weight: 700; }
.note { margin: 0 0 var(--space-2); }
.error { background: var(--color-coral); color: var(--color-coral-deep); padding: var(--space-3); border-radius: var(--radius-m); }
.modal-backdrop { position: fixed; inset: 0; z-index: 20; overflow: auto; background: rgb(12 15 20 / 40%); display: grid; place-items: center; padding: var(--space-4); }
.modal { background: var(--color-bg-soft); border-radius: var(--radius-xl); padding: var(--space-5); width: min(420px, 100%); box-sizing: border-box; display: grid; gap: var(--space-3); }
.modal h2 { margin: 0; font-weight: 900; }
select { font: inherit; padding: var(--space-2); border: 1px solid var(--color-bg-line); border-radius: var(--radius-m); background: var(--color-bg); }
.actions { display: flex; flex-wrap: wrap; gap: var(--space-2); justify-content: flex-end; }
.chip, .primary { font: inherit; font-weight: 700; border-radius: var(--radius-pill); padding: var(--space-2) var(--space-3); cursor: pointer; }
.chip { border: 1px solid var(--color-bg-line); background: transparent; color: var(--color-ink-muted); }
.primary { border: none; background: var(--color-sun); color: var(--color-ink); font-weight: 800; }
</style>
