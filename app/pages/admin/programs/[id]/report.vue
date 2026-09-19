<script setup lang="ts">
definePageMeta({ layout: 'admin', middleware: 'admin-scope', requiredScope: 'report.team' })
const { t } = useI18n()
const { api } = useApi()
const route = useRoute()
interface Rep { program: { id: string, title: string }, total: number, completed: number, funnel: { nodeId: string, title: string, reached: number, done: number, failed: number, avgScore: number | null }[], people: { enrollmentId: string, fullName: string, status: string, progressPct: number, dueAt: string | null, currentStep: number | null, currentTitle: string | null }[] }
const rep = ref<Rep | null>(null)
const error = ref('')
onMounted(async () => { try { rep.value = await api(`/programs/${route.params.id}/report`) } catch (err) { error.value = apiErrorOf(err).message } })
</script>
<template>
  <div>
    <NuxtLink :to="`/admin/programs/${route.params.id}`" class="back">← {{ t('prog.builder') }}</NuxtLink>
    <p v-if="error" class="error">{{ error }}</p>
    <template v-if="rep">
      <h1>{{ rep.program.title }}</h1>
      <p class="sub">{{ t('prog.reportLine', { total: rep.total, completed: rep.completed }) }}</p>
      <section class="card">
        <h2>{{ t('prog.funnel') }}</h2>
        <div v-for="(f, i) in rep.funnel" :key="f.nodeId" class="bar">
          <span class="lbl">{{ i + 1 }}. {{ f.title }}</span>
          <div class="track"><i :style="{ width: `${rep.total ? f.reached / rep.total * 100 : 0}%` }" /><b :style="{ width: `${rep.total ? f.done / rep.total * 100 : 0}%` }" /></div>
          <span class="sub">{{ t('prog.reachedDone', { r: f.reached, d: f.done }) }}<template v-if="f.failed"> · ✕ {{ f.failed }}</template><template v-if="f.avgScore != null"> · {{ f.avgScore }}%</template></span>
        </div>
      </section>
      <table class="table">
        <thead><tr><th>{{ t('people.col.name') }}</th><th>{{ t('prog.currentStep') }}</th><th>%</th><th>{{ t('dev.due') }}</th><th>{{ t('assign.col.status') }}</th></tr></thead>
        <tbody><tr v-for="p in rep.people" :key="p.enrollmentId"><td>{{ p.fullName }}</td><td>{{ p.currentStep ? `${p.currentStep}. ${p.currentTitle}` : '—' }}</td><td>{{ p.progressPct }}</td><td class="sub">{{ p.dueAt ? new Date(p.dueAt).toLocaleDateString('uk-UA') : '' }}</td><td><span :class="['badge', p.status]">{{ t(`prog.status.${p.status}`) }}</span></td></tr></tbody>
      </table>
    </template>
  </div>
</template>
<style scoped>
.back { color: var(--color-ink-muted); text-decoration: none; font-weight: 700; }
h1 { margin: var(--space-2) 0 0; font-weight: 900; }
h2 { margin: 0; font-weight: 800; }
.card { background: var(--color-bg-soft); border-radius: var(--radius-l); padding: var(--space-4); display: grid; gap: var(--space-2); margin: var(--space-3) 0; }
.bar { display: grid; grid-template-columns: 220px 1fr 180px; gap: var(--space-2); align-items: center; font-size: var(--font-size-body-s); }
.lbl { font-weight: 700; }
.track { position: relative; height: 14px; background: var(--color-bg-line); border-radius: var(--radius-pill); overflow: hidden; }
.track i, .track b { position: absolute; left: 0; top: 0; height: 100%; display: block; }
.track i { background: var(--color-sun); }
.track b { background: var(--color-teal); }
.table { width: 100%; border-collapse: collapse; background: var(--color-bg-soft); border-radius: var(--radius-m); overflow: hidden; }
th { text-align: left; font-size: var(--font-size-body-s); color: var(--color-ink-muted); padding: var(--space-2) var(--space-3); border-bottom: 1px solid var(--color-bg-line); }
td { padding: var(--space-2) var(--space-3); border-bottom: 1px solid var(--color-bg-line-soft); }
.badge { font-size: var(--font-size-body-s); font-weight: 700; border-radius: var(--radius-pill); padding: 2px var(--space-3); background: var(--color-bg-line-soft); }
.badge.completed { background: var(--color-teal); color: var(--color-teal-deep); }
.badge.in_progress { background: var(--color-sun); color: var(--color-sun-ink); }
.sub { font-size: var(--font-size-body-s); color: var(--color-ink-faint); margin: 0; }
.error { color: var(--color-coral-ink); }
</style>
