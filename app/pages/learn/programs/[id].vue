<script setup lang="ts">
definePageMeta({ layout: 'learner' })
const { t } = useI18n()
const { api } = useApi()
const route = useRoute()
interface Step { id: string, title: string, itemType: string | null, isRequired: boolean, state: { status: string, at?: string, score?: number | null, dueAt?: string | null }, opensAfter: string }
interface Ladder { enrollment: { id: string, status: string, progressPct: number, dueAt: string | null, completedAt: string | null }, program: { title: string, description: string | null, mode: string }, steps: Step[], done: number, total: number }
const l = ref<Ladder | null>(null)
const error = ref('')
async function load() { try { l.value = await api<Ladder>(`/learning/programs/${route.params.id}`) } catch (err) { error.value = apiErrorOf(err).message } }
onMounted(load)
async function open(s: Step) {
  error.value = ''
  try { const r = await api<{ to: string }>(`/learning/programs/${route.params.id}/open`, { method: 'POST', body: { nodeId: s.id } }); await navigateTo(r.to) }
  catch (err) { error.value = apiErrorOf(err).message }
}
const fmt = (d: string | null | undefined) => d ? new Date(d).toLocaleDateString('uk-UA') : ''
</script>
<template>
  <div>
    <NuxtLink to="/learn/programs" class="back">← {{ t('prog.title') }}</NuxtLink>
    <p v-if="error" class="error">{{ error }}</p>
    <template v-if="l">
      <h1>{{ l.program.title }}</h1>
      <div class="progress-card">
        <div class="progress-head">
          <span>{{ t('prog.progressN', { n: l.done, total: l.total }) }}</span>
          <span class="pct">{{ Math.round(l.enrollment.progressPct) }}%</span>
        </div>
        <div class="bar"><i :style="{ width: `${Math.min(100, l.enrollment.progressPct)}%` }" /></div>
      </div>
      <p v-if="l.enrollment.dueAt || l.enrollment.status === 'done'" class="sub"><template v-if="l.enrollment.dueAt">{{ t('dev.due') }} {{ fmt(l.enrollment.dueAt) }}</template><template v-if="l.enrollment.dueAt && l.enrollment.status === 'done'"> · </template><template v-if="l.enrollment.status === 'done'">✓ {{ t('prog.status.completed') }} {{ fmt(l.enrollment.completedAt) }}</template></p>
      <p v-if="l.program.description" class="text">{{ l.program.description }}</p>
      <ol class="ladder">
        <li v-for="(s, i) in l.steps" :key="s.id" :class="['step', s.state.status]" :data-testid="`step-${s.id}`">
          <span class="num">{{ s.state.status === 'done' ? '✓' : s.state.status === 'locked' ? '🔒' : s.state.status === 'failed' ? '✕' : s.state.status === 'available' || s.state.status === 'in_progress' ? '→' : i + 1 }}</span>
          <div class="body">
            <b>{{ s.title }}</b>
            <span class="sub">{{ t(`prog.itemType.${s.itemType ?? 'course'}`) }}<template v-if="!s.isRequired"> · {{ t('prog.optional') }}</template><template v-if="s.state.score != null"> · {{ s.state.score }}%</template><template v-if="s.state.dueAt && s.state.status !== 'done'"> · {{ t('dev.due') }} {{ fmt(s.state.dueAt) }}</template></span>
            <span v-if="s.state.status === 'locked' && s.opensAfter" class="sub">{{ t('prog.opensAfter', { title: s.opensAfter }) }}</span>
            <button v-if="['available', 'in_progress', 'failed'].includes(s.state.status)" class="primary" :data-testid="`open-${s.id}`" @click="open(s)">{{ s.state.status === 'available' ? t('prog.start') : s.state.status === 'failed' ? t('prog.retry') : t('prog.continue') }}</button>
          </div>
        </li>
      </ol>
    </template>
  </div>
</template>
<style scoped>
.back { color: var(--color-ink-muted); text-decoration: none; font-weight: 700; }
h1 { margin: var(--space-2) 0 0; font-weight: 900; }
.sub { color: var(--color-ink-muted); font-size: var(--font-size-body-s); margin: var(--space-1) 0; }
.text { margin: var(--space-2) 0; }
.progress-card { background: var(--color-bg-soft); border: 2px solid var(--color-bg-line); border-radius: var(--radius-m); padding: var(--space-3) var(--space-4); margin-top: var(--space-3); }
.progress-head { display: flex; justify-content: space-between; align-items: baseline; margin-bottom: var(--space-2); font-weight: 800; font-size: var(--font-size-body-s); }
.progress-head .pct { font-weight: 900; font-variant-numeric: tabular-nums; }
.progress-card .bar { height: 8px; background: var(--color-bg-line-soft); border-radius: var(--radius-pill); overflow: hidden; }
.progress-card .bar i { display: block; height: 100%; background: var(--color-teal); border-radius: var(--radius-pill); }
.ladder { list-style: none; margin: var(--space-3) 0 0; padding: 0; }
.step { position: relative; display: flex; gap: var(--space-3); padding: 0 0 var(--space-4); }
.step:last-child { padding-bottom: 0; }
.step:not(:last-child)::after { content: ''; position: absolute; top: 36px; left: 17px; width: 2px; bottom: 0; background: var(--color-bg-line); }
.num { position: relative; width: 36px; height: 36px; border-radius: 18px; display: grid; place-items: center; font-weight: 900; background: var(--color-bg-line); color: var(--color-ink-muted); flex: none; }
.step.done .num { background: var(--color-teal); color: var(--color-teal-deep); }
.step.available .num, .step.in_progress .num { background: var(--color-sun); color: var(--color-sun-ink); }
.step.failed .num { background: var(--color-coral); color: var(--color-coral-deep); }
.step.locked { opacity: 0.6; }
.body { display: grid; gap: 4px; flex: 1; }
.primary { font: inherit; font-weight: 800; border: none; background: var(--color-sun); color: var(--color-ink); border-radius: var(--radius-pill); padding: var(--space-2) var(--space-3); cursor: pointer; justify-self: start; }
.error { background: var(--color-coral); color: var(--color-coral-deep); padding: var(--space-3); border-radius: var(--radius-m); }
</style>
