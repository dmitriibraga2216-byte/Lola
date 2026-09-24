<script setup lang="ts">
const { formatShortDate } = useFormat()
definePageMeta({ layout: 'learner' })
const { t } = useI18n()
const { api } = useApi()
interface Mine { id: string, status: string, progress_pct: string, due_at: string | null, title: string, mode: string, total: number, program_id: string }
interface Cat { id: string, title: string, description: string | null, items: number, assignment_mode: string[], my_status: string | null }
const data = ref<{ mine: Mine[], catalog: Cat[] }>({ mine: [], catalog: [] })
const error = ref('')
const notice = ref('')
async function load() { try { data.value = await api('/learning/programs') } catch (err) { error.value = apiErrorOf(err).message } }
onMounted(load)
async function enroll(c: Cat) {
  error.value = ''; notice.value = ''
  try { const r = await api<{ requested?: boolean, enrollmentId?: string }>(`/learning/programs/${c.id}/enroll`, { method: 'POST' }); notice.value = r.requested ? t('prog.requested') : t('prog.enrolled'); await load() }
  catch (err) { error.value = apiErrorOf(err).message }
}
const fmt = (d: string | null) => d ? formatShortDate(new Date(d)) : ''
</script>
<template>
  <div>
    <h1>{{ t('prog.title') }}</h1>
    <p v-if="error" class="error">{{ error }}</p>
    <p v-if="notice" class="notice">{{ notice }}</p>
    <p v-if="!data.mine.length" class="empty">{{ t('prog.empty') }}</p>
    <div class="list">
      <NuxtLink v-for="m in data.mine" :key="m.id" :to="`/learn/programs/${m.id}`" class="card" :data-testid="`prog-${m.program_id}`">
        <div class="row"><span class="card-title">{{ m.mode === 'graph' ? '🧭 ' : '' }}{{ m.title }}</span><span :class="['badge', m.status]">{{ t(`prog.status.${m.status}`) }}</span></div>
        <div class="progress"><span :style="{ width: `${Number(m.progress_pct)}%` }" /></div>
        <span class="sub">{{ Number(m.progress_pct) }}%<template v-if="m.due_at"> · {{ t('dev.due') }} {{ fmt(m.due_at) }}</template></span>
      </NuxtLink>
    </div>
    <template v-if="data.catalog.length">
      <h2>{{ t('prog.catalog') }}</h2>
      <div class="list">
        <div v-for="c in data.catalog" :key="c.id" class="card">
          <span class="card-title">{{ c.title }}</span>
          <span v-if="c.description" class="sub">{{ c.description }}</span>
          <span class="sub">{{ t('prog.itemsN', { n: c.items }) }}</span>
          <div class="row">
            <span v-if="c.my_status && c.my_status !== 'cancelled'" class="badge">{{ t(`prog.status.${c.my_status}`) }}</span>
            <button v-else class="primary" @click="enroll(c)">{{ c.assignment_mode.includes('catalog_free') ? t('prog.enroll') : t('prog.request') }}</button>
          </div>
        </div>
      </div>
    </template>
  </div>
</template>
<style scoped>
h1 { margin: 0 0 var(--space-3); font-weight: 900; }
h2 { margin: var(--space-4) 0 var(--space-2); font-weight: 800; font-size: var(--font-size-title-l); }
.list { display: grid; gap: var(--space-2); }
.card { background: var(--color-bg-soft); border-radius: var(--radius-l); padding: var(--space-3); display: grid; gap: var(--space-1); color: inherit; text-decoration: none; }
.row { display: flex; justify-content: space-between; gap: var(--space-2); align-items: center; }
.card-title { font-weight: 800; }
.sub { color: var(--color-ink-muted); font-size: var(--font-size-body-s); }
.progress { height: 6px; border-radius: 3px; background: var(--color-bg-line); overflow: hidden; }
.progress span { display: block; height: 100%; background: var(--color-teal); }
.badge { font-size: var(--font-size-body-s); font-weight: 700; border-radius: var(--radius-pill); padding: 2px var(--space-2); background: var(--color-bg); color: var(--color-ink-muted); }
.badge.completed { background: var(--color-teal); color: var(--color-teal-deep); }
.badge.in_progress { background: var(--color-sun); color: var(--color-sun-ink); }
.badge.expired, .badge.failed { background: var(--color-coral); color: var(--color-coral-deep); }
.primary { font: inherit; font-weight: 800; border: none; background: var(--color-sun); color: var(--color-ink); border-radius: var(--radius-pill); padding: var(--space-2) var(--space-3); cursor: pointer; }
.empty { color: var(--color-ink-muted); padding: var(--space-3); }
.error { background: var(--color-coral); color: var(--color-coral-deep); padding: var(--space-3); border-radius: var(--radius-m); }
.notice { background: var(--color-teal); color: var(--color-teal-deep); padding: var(--space-3); border-radius: var(--radius-m); }
</style>
