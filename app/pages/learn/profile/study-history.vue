<script setup lang="ts">
/**
 * «Моя історія навчання» (docs/22 §13.5, docs/mockups/screens/StudyHistory.html): рейтинг
 * (свій/зовнішній ряд наростаючим підсумком) і список пройденого зі статусом. Телефон — перш за все.
 */
const { formatShortDate } = useFormat()
definePageMeta({ layout: 'learner' })
const { t } = useI18n()
const { api } = useApi()

interface Item { title: string, contentType: string, status: string, resultPct: number | null, date: string, external: boolean }
interface Series { period: string, mine: number, external: number }
interface History { profile: { full_name: string } | null, currentRating: number, series: Series[], items: Item[] }

const data = ref<History | null>(null)
const error = ref('')

onMounted(async () => {
  try { data.value = await api<History>('/me/study-history') }
  catch (err) { error.value = apiErrorOf(err).message }
})

const maxCount = computed(() => Math.max(1, ...(data.value?.series.map(s => Math.max(s.mine, s.external)) ?? [1])))
const fmt = (iso: string) => formatShortDate(new Date(iso))
const statusLabel = (s: string) => t(`studyHistory.status.${s}`)
</script>

<template>
  <div>
    <div class="head">
      <NuxtLink to="/learn/profile" class="back" :aria-label="t('common.back')">
        <svg viewBox="0 0 24 24" aria-hidden="true"><path d="M19 12H6" stroke="currentColor" stroke-width="2" fill="none" stroke-linecap="round" /><path d="M11 18l-6-6 6-6" stroke="currentColor" stroke-width="2" fill="none" stroke-linecap="round" stroke-linejoin="round" /></svg>
      </NuxtLink>
      <h1>{{ t('studyHistory.title') }}</h1>
    </div>
    <p v-if="error" class="error">{{ error }}</p>

    <template v-if="data">
      <div class="rating card">
        <span class="label">{{ t('studyHistory.currentRating') }}</span>
        <span class="value">{{ data.currentRating }}</span>
        <div class="chart">
          <div v-for="s in data.series" :key="s.period" class="bars">
            <span class="bar mine" :style="{ height: `${Math.max(6, Math.round(s.mine / maxCount * 52))}px` }" />
            <span class="bar ext" :style="{ height: `${Math.max(6, Math.round(s.external / maxCount * 52))}px` }" />
          </div>
        </div>
        <div class="legend">
          <span><i class="dot mine" />{{ t('studyHistory.legendMine') }}</span>
          <span><i class="dot ext" />{{ t('studyHistory.legendExternal') }}</span>
        </div>
      </div>

      <p v-if="data.items.length === 0" class="empty">{{ t('studyHistory.empty') }}</p>
      <div class="list">
        <div v-for="(it, i) in data.items" :key="i" class="row">
          <div class="row-main">
            <span class="title">{{ it.title }}<span v-if="it.external" class="badge sun">{{ t('studyHistory.external') }}</span></span>
            <span class="sub">{{ fmt(it.date) }} · {{ statusLabel(it.status) }}</span>
          </div>
          <span :class="['status', it.status]">{{ it.resultPct != null ? `${it.resultPct}%` : '' }}</span>
        </div>
      </div>
    </template>
  </div>
</template>

<style scoped>
.head { display: flex; align-items: center; gap: var(--space-3); margin-bottom: var(--space-3); }
.back { border: none; background: none; padding: 0; cursor: pointer; color: var(--color-ink); display: flex; }
h1 { margin: 0; font-weight: 900; font-size: var(--font-size-title-l); }
.card { background: var(--color-bg-soft); border-radius: var(--radius-l); padding: var(--space-4); margin-bottom: var(--space-3); }
.label { display: block; font-size: var(--font-size-body-s); color: var(--color-ink-muted); font-weight: 700; }
.value { display: block; font-family: ui-monospace, monospace; font-size: 32px; font-weight: 900; }
.chart { display: flex; gap: 4px; align-items: flex-end; height: 56px; margin-top: var(--space-3); }
.bars { flex: 1; display: flex; gap: 2px; align-items: flex-end; }
.bar { flex: 1; border-radius: 5px 5px 2px 2px; }
.bar.mine { background: var(--color-teal); }
.bar.ext { background: var(--color-sun); }
.legend { display: flex; gap: var(--space-3); margin-top: var(--space-2); font-size: var(--font-size-body-s); font-weight: 700; color: var(--color-ink-muted); }
.legend span { display: flex; align-items: center; gap: 5px; }
.dot { width: 10px; height: 10px; border-radius: 3px; display: inline-block; }
.dot.mine { background: var(--color-teal); }
.dot.ext { background: var(--color-sun); }
.list { display: grid; gap: var(--space-2); }
.row { display: flex; justify-content: space-between; align-items: center; gap: var(--space-2); background: var(--color-bg-soft); border-radius: var(--radius-m); padding: var(--space-3); }
.row-main { display: grid; gap: 2px; min-width: 0; }
.title { font-weight: 800; display: flex; align-items: center; gap: var(--space-2); }
.sub { font-size: var(--font-size-body-s); color: var(--color-ink-muted); }
.badge { font-size: 11px; font-weight: 700; border-radius: var(--radius-pill); padding: 1px var(--space-2); white-space: nowrap; }
.badge.sun { background: var(--color-sun); color: var(--color-ink); }
.status { font-weight: 800; white-space: nowrap; }
.status.failed { color: var(--color-coral-ink); }
.status.done { color: var(--color-teal-ink); }
.empty { color: var(--color-ink-muted); padding: var(--space-3); }
.error { background: var(--color-coral); color: var(--color-coral-deep); border-radius: var(--radius-m); padding: var(--space-3); }
</style>
