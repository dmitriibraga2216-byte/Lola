<script setup lang="ts">
/**
 * «Індекс залученості» — `/admin/reports/rating` (docs/v2/38 §9 п. 5, §7.3). Текущий снимок
 * людей в области смотрящего (`person.rating.view_others`): основа, три бонуса и итог. Порядок —
 * по ПІБ, места нет (Р-38.6). Выгрузка — только после галки «Показник довідковий…»; сервер без
 * `confirm=1` файл не отдаёт. Администратор пространства запускает ретро-расчёт динамики за 12
 * месяцев (Р-38.7).
 */
definePageMeta({ layout: 'admin', middleware: 'admin-scope', requiredScope: 'person.rating.view_others' })

interface Row {
  userId: string, fullName: string, location: string | null, basePct: number, bonusEarly: number
  bonusStreak: number, bonusHelp: number, totalPct: number, calcDate: string
}

const { t } = useI18n()
const { api } = useApi()
const { hasScope } = useAuth()
const { formatShortDate, formatNumber } = useFormat()

const q = ref('')
const confirmed = ref(false)
const rows = ref<Row[] | null>(null)
const error = ref(false)
const busy = ref(false)
const backfillState = ref<'idle' | 'queued' | 'error'>('idle')

const query = (): Record<string, string> => (q.value.trim() ? { q: q.value.trim() } : {})

async function load() {
  busy.value = true
  error.value = false
  rows.value = null
  try { rows.value = await api<Row[]>('/reports/rating', { query: query() }) }
  catch { error.value = true }
  finally { busy.value = false }
}
onMounted(load)

const exportUrl = (format: 'xlsx' | 'csv') => `/api/v1/reports/rating?${new URLSearchParams({ ...query(), format, confirm: '1' }).toString()}`
const pct = (v: number) => formatNumber(v, { maximumFractionDigits: 1 })

async function backfill() {
  try {
    await api('/reports/rating/backfill', { method: 'POST' })
    backfillState.value = 'queued'
  }
  catch { backfillState.value = 'error' }
}
</script>

<template>
  <div>
    <PageHeader :title="t('ratingReport.title')" :subtitle="t('ratingReport.hint')" />

    <p class="note sun">{{ t('ratingReport.disclaimer') }}</p>

    <form class="filters" @submit.prevent="load">
      <label>{{ t('ratingReport.search') }} <input v-model="q" class="field" type="search" :placeholder="t('ratingReport.searchPlaceholder')"></label>
      <button class="btn primary" type="submit" :disabled="busy">{{ t('ratingReport.apply') }}</button>
    </form>

    <div v-if="hasScope('report.export')" class="export" data-testid="rating-export">
      <label class="check">
        <input v-model="confirmed" type="checkbox">
        {{ t('ratingReport.confirm') }}
      </label>
      <template v-if="confirmed">
        <a class="btn ghost" :href="exportUrl('xlsx')" download>{{ t('ratingReport.exportXlsx') }}</a>
        <a class="btn ghost" :href="exportUrl('csv')" download>{{ t('ratingReport.exportCsv') }}</a>
      </template>
      <span v-else class="muted">{{ t('ratingReport.confirmFirst') }}</span>
    </div>

    <div v-if="error" class="note coral" role="alert">
      {{ t('ratingReport.loadError') }}
      <button type="button" class="btn ghost" @click="load">{{ t('ratingReport.retry') }}</button>
    </div>
    <p v-else-if="!rows" class="muted" aria-busy="true">{{ t('ratingReport.loading') }}</p>
    <p v-else-if="rows.length === 0" class="muted">{{ t('ratingReport.empty') }}</p>
    <div v-else class="table-wrap">
      <table class="table">
        <thead>
          <tr>
            <th>{{ t('ratingReport.col.person') }}</th>
            <th>{{ t('ratingReport.col.location') }}</th>
            <th class="num">{{ t('ratingReport.col.base') }}</th>
            <th class="num">{{ t('ratingReport.col.early') }}</th>
            <th class="num">{{ t('ratingReport.col.streak') }}</th>
            <th class="num">{{ t('ratingReport.col.help') }}</th>
            <th class="num">{{ t('ratingReport.col.total') }}</th>
          </tr>
        </thead>
        <tbody>
          <tr v-for="r in rows" :key="r.userId">
            <td><NuxtLink :to="`/admin/people/${r.userId}/rating`">{{ r.fullName }}</NuxtLink></td>
            <td>{{ r.location ?? '—' }}</td>
            <td class="num">{{ pct(r.basePct) }}</td>
            <td class="num">+{{ pct(r.bonusEarly) }}</td>
            <td class="num">+{{ pct(r.bonusStreak) }}</td>
            <td class="num">+{{ pct(r.bonusHelp) }}</td>
            <td class="num" :title="t('ratingReport.calcDate', { date: formatShortDate(r.calcDate) })">{{ pct(r.totalPct) }} %</td>
          </tr>
        </tbody>
      </table>
    </div>

    <section v-if="hasScope('settings.tenant')" class="card backfill">
      <h2>{{ t('ratingReport.backfillTitle') }}</h2>
      <p class="sub">{{ t('ratingReport.backfillHint') }}</p>
      <button type="button" class="btn" :disabled="backfillState === 'queued'" @click="backfill">{{ t('ratingReport.backfill') }}</button>
      <p v-if="backfillState === 'queued'" class="note teal" role="status">{{ t('ratingReport.backfillQueued') }}</p>
      <p v-if="backfillState === 'error'" class="note coral" role="alert">{{ t('ratingReport.backfillError') }}</p>
    </section>
  </div>
</template>

<style scoped>
.filters { display: flex; flex-wrap: wrap; gap: var(--space-2); align-items: end; margin-bottom: var(--space-3); }
.filters label { display: grid; gap: var(--space-1); font-size: var(--font-size-body-s); font-weight: 700; }
.filters .field { width: auto; min-width: 180px; padding: var(--space-2) var(--space-3); }
.export { display: flex; flex-wrap: wrap; gap: var(--space-2); align-items: center; margin-bottom: var(--space-3); }
.check { display: flex; gap: var(--space-2); align-items: flex-start; font-size: var(--font-size-body-s); min-width: 0; }
.backfill { margin-top: var(--space-4); }
@media (max-width: 480px) {
  .filters { flex-direction: column; align-items: stretch; }
  .filters .field { width: 100%; min-width: 0; }
}
</style>
