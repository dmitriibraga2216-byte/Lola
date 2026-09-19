<script setup lang="ts">
definePageMeta({ layout: 'learner', middleware: 'admin-scope', requiredScope: 'checklist.run' })
const { t } = useI18n()
const { api } = useApi()
const route = useRoute()
interface Run { id: string, status: string, startedAt: string, finishedAt: string | null, score: string | null, passed: boolean | null, criticalFailed: string[], signatureMediaId: string | null, isExternal?: boolean, answers: { itemId: string, value: number | null, comment: string | null, photoMediaIds?: string[], isNa?: boolean }[], actionPlan: { id: string, text: string, responsibleId: string, dueAt: string, status: string }[], checklist: { title: string, items: { id: string, text: string, group?: string }[] }, observerName: string, locationName: string | null, responsibles: Record<string, string> }
const run = ref<Run | null>(null)
const error = ref('')
async function load() { try { run.value = await api<Run>(`/checklist-runs/${route.params.runId}`) } catch (err) { error.value = apiErrorOf(err).message } }
onMounted(load)
async function toggle(a: Run['actionPlan'][number]) {
  try { await api(`/checklist-runs/${route.params.runId}/actions/${a.id}`, { method: 'PATCH', body: { status: a.status === 'done' ? 'open' : 'done' } }); await load() } catch (err) { error.value = apiErrorOf(err).message }
}
const ans = (id: string) => run.value?.answers.find(a => a.itemId === id)
const fmt = (d: string | null) => d ? new Date(d).toLocaleString('uk-UA', { dateStyle: 'short', timeStyle: 'short' }) : '—'
</script>
<template>
  <div>
    <NuxtLink to="/learn/checklists" class="back">← {{ t('cl.title') }}</NuxtLink>
    <p v-if="error" class="error">{{ error }}</p>
    <template v-if="run">
      <h1>{{ run.checklist.title }}</h1>
      <p class="sub">{{ run.locationName ?? '' }} · {{ run.observerName }} · {{ fmt(run.startedAt) }} → {{ fmt(run.finishedAt) }}</p>
      <div v-if="run.status === 'finished'" :class="['score', run.passed ? 'ok' : 'bad']">{{ Number(run.score) }}%<small>{{ run.passed ? t('cl.passed') : t('cl.failed') }}</small></div>
      <section class="group">
        <div v-for="it in run.checklist.items" :key="it.id" class="item">
          <div class="row"><span>{{ it.text }}</span><b :class="{ crit: run.criticalFailed.includes(it.id) }">{{ ans(it.id)?.isNa ? t('assess.na') : ans(it.id)?.value ?? '—' }}</b></div>
          <div v-if="ans(it.id)?.comment" class="sub">{{ ans(it.id)?.comment }}</div>
          <div v-if="ans(it.id)?.photoMediaIds?.length" class="photos"><img v-for="m in ans(it.id)!.photoMediaIds" :key="m" :src="`/api/v1/media/${m}?redirect=1`" alt=""></div>
        </div>
      </section>
      <section v-if="run.actionPlan.length" class="group">
        <h2>{{ t('cl.actionPlan') }}</h2>
        <label v-for="a in run.actionPlan" :key="a.id" :class="['action', a.status]">
          <input type="checkbox" :checked="a.status === 'done'" @change="toggle(a)">
          <span>{{ a.text }}<br><small class="sub">{{ run.responsibles[a.responsibleId] ?? '' }} · {{ t('dev.due') }} {{ a.dueAt }}<template v-if="a.status === 'overdue'"> · {{ t('dev.overdue') }}</template></small></span>
        </label>
      </section>
      <section v-if="run.signatureMediaId" class="card">
        <h2>{{ t('cl.signature') }}</h2>
        <img :src="`/api/v1/media/${run.signatureMediaId}?redirect=1`" :alt="t('cl.signature')" class="signature">
      </section>
      <p v-if="run.isExternal" class="sub">{{ t('mystery.externalRun') }}</p>
    </template>
  </div>
</template>
<style scoped>
.back { color: var(--color-ink-muted); text-decoration: none; font-weight: 700; }
h1 { margin: var(--space-2) 0 0; font-weight: 900; }
h2 { margin: 0; font-weight: 800; }
.sub { color: var(--color-ink-muted); font-size: var(--font-size-body-s); }
.score { font-size: var(--font-size-display); font-weight: 900; display: grid; margin: var(--space-2) 0; }
.score small { font-size: var(--font-size-body); }
.score.ok { color: var(--color-teal-deep); }
.score.bad { color: var(--color-coral-deep); }
.group { background: var(--color-bg-soft); border-radius: var(--radius-l); padding: var(--space-3); display: grid; gap: var(--space-2); margin-top: var(--space-3); }
.item { border-top: 1px solid var(--color-bg-line-soft); padding-top: var(--space-2); display: grid; gap: 4px; }
.row { display: flex; justify-content: space-between; gap: var(--space-2); }
.crit { color: var(--color-coral-deep); }
.photos { display: flex; gap: var(--space-1); flex-wrap: wrap; }
.photos img { width: 72px; height: 72px; object-fit: cover; border-radius: var(--radius-s); }
.action { display: flex; gap: var(--space-2); align-items: start; }
.action.done { opacity: 0.6; text-decoration: line-through; }
.action.overdue { color: var(--color-coral-deep); }
.error { background: var(--color-coral); color: var(--color-coral-deep); padding: var(--space-3); border-radius: var(--radius-m); }
.signature { max-width: 100%; height: 120px; background: var(--color-bg); border-radius: var(--radius-m); }
</style>
