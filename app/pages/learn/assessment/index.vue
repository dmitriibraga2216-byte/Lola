<script setup lang="ts">
const { formatShortDate } = useFormat()
definePageMeta({ layout: 'learner' })
const { t } = useI18n()
const { api } = useApi()
interface Rating { id: string, status: string, rater_kind: string, due_at: string, cycle_id: string, cycle_title: string, subject_name: string, subject_id: string, answered: number }
interface Rated { cycle_id: string, title: string, status: string, ends_at: string, raters: number, submitted: number }
const data = ref<{ rating: Rating[], rated: Rated[] }>({ rating: [], rated: [] })
const tab = ref<'me' | 'i' | 'results'>('i')
const error = ref('')
onMounted(async () => {
  try { data.value = await api('/assessment/my-tasks') } catch (err) { error.value = apiErrorOf(err).message }
  if (data.value.rating.length === 0 && data.value.rated.length) tab.value = 'me'
})
const fmt = (d: string) => formatShortDate(new Date(d))
</script>
<template>
  <div>
    <h1>{{ t('assess.title') }}</h1>
    <p v-if="error" class="error">{{ error }}</p>
    <div class="tabs">
      <button :class="['tab', { on: tab === 'i' }]" @click="tab = 'i'">{{ t('assess.iRate') }} <b v-if="data.rating.filter(r => r.status !== 'submitted').length">{{ data.rating.filter(r => r.status !== 'submitted').length }}</b></button>
      <button :class="['tab', { on: tab === 'me' }]" @click="tab = 'me'">{{ t('assess.rateMe') }}</button>
      <button :class="['tab', { on: tab === 'results' }]" @click="tab = 'results'">{{ t('assess.results') }}</button>
    </div>
    <template v-if="tab === 'i'">
      <p v-if="data.rating.length === 0" class="empty">{{ t('assess.noTasks') }}</p>
      <div class="list">
        <NuxtLink v-for="r in data.rating" :key="r.id" :to="`/learn/assessment/tasks/${r.id}`" class="card">
          <div class="row"><span class="card-title">{{ r.subject_name }}</span><span :class="['badge', r.status]">{{ t(`assess.status.${r.status}`) }}</span></div>
          <span class="sub">{{ r.cycle_title }} · {{ t(`assess.kind.${r.rater_kind}`) }} · {{ t('dev.due') }} {{ fmt(r.due_at) }}</span>
        </NuxtLink>
      </div>
    </template>
    <template v-if="tab === 'me'">
      <p v-if="data.rated.filter(c => c.status !== 'finished').length === 0" class="empty">{{ t('assess.noActive') }}</p>
      <div class="list">
        <div v-for="c in data.rated.filter(c => c.status !== 'finished')" :key="c.cycle_id" class="card">
          <span class="card-title">{{ c.title }}</span>
          <span class="sub">{{ t('assess.ratersProgress', { n: c.submitted, total: c.raters }) }} · {{ t('assess.resultsAt') }} {{ fmt(c.ends_at) }}</span>
        </div>
      </div>
    </template>
    <template v-if="tab === 'results'">
      <p v-if="data.rated.filter(c => c.status === 'finished').length === 0" class="empty">{{ t('assess.noResults') }}</p>
      <div class="list">
        <NuxtLink v-for="c in data.rated.filter(c => c.status === 'finished')" :key="c.cycle_id" :to="`/learn/assessment/results/${c.cycle_id}`" class="card">
          <span class="card-title">{{ c.title }}</span>
          <span class="sub">{{ t('assess.ratersN', { n: c.submitted }) }}</span>
        </NuxtLink>
      </div>
    </template>
  </div>
</template>
<style scoped>
h1 { margin: 0 0 var(--space-3); font-weight: 900; }
.tabs { display: flex; gap: var(--space-1); margin-bottom: var(--space-3); overflow-x: auto; }
.tab { font: inherit; font-weight: 700; border: 1px solid var(--color-bg-line); background: transparent; border-radius: var(--radius-pill); padding: var(--space-1) var(--space-3); white-space: nowrap; color: var(--color-ink-muted); }
.tab.on { background: var(--color-ink); color: var(--color-bg); border-color: var(--color-ink); }
.tab b { background: var(--color-coral); color: var(--color-coral-deep); border-radius: var(--radius-pill); padding: 0 6px; margin-left: 4px; }
.list { display: grid; gap: var(--space-2); }
.card { background: var(--color-bg-soft); border-radius: var(--radius-l); padding: var(--space-3); display: grid; gap: var(--space-1); color: inherit; text-decoration: none; }
.row { display: flex; justify-content: space-between; gap: var(--space-2); align-items: center; }
.card-title { font-weight: 800; }
.sub { color: var(--color-ink-muted); font-size: var(--font-size-body-s); }
.badge { font-size: var(--font-size-body-s); font-weight: 700; border-radius: var(--radius-pill); padding: 2px var(--space-2); background: var(--color-bg); color: var(--color-ink-muted); }
.badge.submitted { background: var(--color-teal); color: var(--color-teal-deep); }
.badge.in_progress { background: var(--color-sun); color: var(--color-sun-ink); }
.empty { color: var(--color-ink-muted); padding: var(--space-3); }
.error { background: var(--color-coral); color: var(--color-coral-deep); padding: var(--space-3); border-radius: var(--radius-m); }
</style>
