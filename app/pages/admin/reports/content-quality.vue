<script setup lang="ts">
/**
 * «Якість контенту» — `/admin/reports/content-quality` (docs/v2/36 §9, критерий 9).
 *
 * Сортировка — по «Скарг на 100 проходжень»: без нормировки в топе оказался бы самый
 * популярный курс, а не худший. Люди числителя и знаменателя отобраны единым каркасом отчётов
 * (docs/22 §13.3): только сотрудники, в области видимости роли, без архивированных. Клик
 * по строке — детализация: кто пожаловался, теми же колонками каркаса.
 */
import { CONTENT_ISSUE_TARGET_TYPES, CONTENT_ISSUE_TYPES } from '#shared/enums'
import type { ContentQualityReport, ContentQualityRow } from '#shared/schemas/contentIssues'

definePageMeta({ layout: 'admin', middleware: 'admin-scope', requiredScope: 'content_issue.view' })

const { t } = useI18n()
const { api } = useApi()
const { hasScope } = useAuth()
const { formatShortDate, formatNumber } = useFormat()

const filters = reactive({
  from: new Date(Date.now() - 90 * 86_400_000).toISOString().slice(0, 10),
  to: new Date().toISOString().slice(0, 10),
  groupBy: 'element' as 'element' | 'course',
  issueType: '',
  targetType: '',
})
const report = ref<ContentQualityReport | null>(null)
const drill = ref<ContentQualityRow | null>(null)
const people = ref<Record<string, unknown>[]>([])
const error = ref('')
const busy = ref(false)

function query(extra: Record<string, string> = {}) {
  const q: Record<string, string> = { groupBy: filters.groupBy, ...extra }
  if (filters.from) q.from = filters.from
  if (filters.to) q.to = filters.to
  if (filters.issueType) q.issueType = filters.issueType
  if (filters.targetType) q.targetType = filters.targetType
  return q
}

async function load() {
  busy.value = true
  error.value = ''
  drill.value = null
  try { report.value = await api<ContentQualityReport>('/reports/content-quality', { query: query() }) }
  catch (err) { error.value = apiErrorOf(err).message }
  finally { busy.value = false }
}
onMounted(load)

async function openDrill(row: ContentQualityRow) {
  if (drill.value?.key === row.key) { drill.value = null; return }
  drill.value = row
  people.value = []
  try {
    const r = await api<ContentQualityReport>('/reports/content-quality', { query: query({ drillKey: row.key }) })
    people.value = r.people ?? []
  }
  catch (err) { error.value = apiErrorOf(err).message }
}

const exportUrl = computed(() => `/api/v1/reports/content-quality?${new URLSearchParams({ ...query(), format: 'xlsx' }).toString()}`)
const num = (v: number | null, digits = 1) => v === null ? '—' : formatNumber(v, { maximumFractionDigits: digits })
const typeOf = (r: ContentQualityRow) => t(`contentIssues.target.${r.targetType}`)
</script>

<template>
  <div>
    <PageHeader :title="t('contentQuality.title')" :subtitle="t('contentQuality.hint')">
      <template #actions>
        <a v-if="hasScope('report.export')" class="btn ghost" :href="exportUrl">{{ t('contentQuality.export') }}</a>
      </template>
    </PageHeader>

    <form class="filters" @submit.prevent="load">
      <label>{{ t('contentQuality.from') }} <input v-model="filters.from" class="field" type="date"></label>
      <label>{{ t('contentQuality.to') }} <input v-model="filters.to" class="field" type="date"></label>
      <label>{{ t('contentQuality.groupBy') }}
        <select v-model="filters.groupBy" class="field">
          <option value="element">{{ t('contentQuality.byElement') }}</option>
          <option value="course">{{ t('contentQuality.byCourse') }}</option>
        </select>
      </label>
      <label>{{ t('contentIssues.filter.type') }}
        <select v-model="filters.issueType" class="field">
          <option value="">{{ t('contentIssues.filter.anyType') }}</option>
          <option v-for="k in CONTENT_ISSUE_TYPES" :key="k" :value="k">{{ t(`issue.type.${k}`) }}</option>
        </select>
      </label>
      <label v-if="filters.groupBy === 'element'">{{ t('contentIssues.filter.targetType') }}
        <select v-model="filters.targetType" class="field">
          <option value="">{{ t('contentIssues.filter.anyType') }}</option>
          <option v-for="k in CONTENT_ISSUE_TARGET_TYPES" :key="k" :value="k">{{ t(`contentIssues.target.${k}`) }}</option>
        </select>
      </label>
      <button class="btn primary" type="submit" :disabled="busy">{{ t('contentQuality.apply') }}</button>
    </form>

    <p v-if="error" class="note coral" role="alert">{{ error }}</p>

    <section v-if="report" class="tiles">
      <div class="tile"><span>{{ t('contentQuality.summary.complaints') }}</span><b>{{ report.summary.complaints }}</b></div>
      <div class="tile"><span>{{ t('contentQuality.summary.passes') }}</span><b>{{ report.summary.passes }}</b></div>
      <div class="tile coral"><span>{{ t('contentQuality.summary.per100') }}</span><b>{{ num(report.summary.per100) }}</b></div>
      <div class="tile"><span>{{ t('contentQuality.summary.open') }}</span><b>{{ report.summary.openNow }}</b></div>
    </section>

    <div v-if="report" class="table-wrap">
      <table class="table" :aria-busy="busy">
        <thead>
          <tr>
            <th>{{ t('contentQuality.col.element') }}</th>
            <th>{{ t('contentQuality.col.type') }}</th>
            <th>{{ t('contentQuality.col.track') }}</th>
            <th>{{ t('contentQuality.col.author') }}</th>
            <th class="num">{{ t('contentQuality.col.passes') }}</th>
            <th class="num">{{ t('contentQuality.col.complaints') }}</th>
            <th class="num">{{ t('contentQuality.col.per100') }}</th>
            <th class="num">{{ t('contentQuality.col.confirmed') }}</th>
            <th class="num">{{ t('contentQuality.col.rejected') }}</th>
            <th class="num">{{ t('contentQuality.col.avgDays') }}</th>
            <th class="num">{{ t('contentQuality.col.open') }}</th>
          </tr>
        </thead>
        <tbody>
          <template v-for="r in report.rows" :key="r.key">
            <tr>
              <td>
                <button class="linkish" type="button" :aria-expanded="drill?.key === r.key" @click="openDrill(r)">{{ r.title }}</button>
              </td>
              <td>{{ typeOf(r) }}</td>
              <td>{{ r.tracks.map(tr => tr.title).join(', ') || '—' }}</td>
              <td>{{ r.authors.join(', ') || '—' }}</td>
              <td class="num">{{ r.passes }}</td>
              <td class="num">{{ r.complaints }}</td>
              <td class="num strong">{{ num(r.per100) }}</td>
              <td class="num">{{ r.confirmed }}</td>
              <td class="num">{{ r.rejected }}</td>
              <td class="num">{{ num(r.avgDaysToFix) }}</td>
              <td class="num">{{ r.openNow }}</td>
            </tr>
            <tr v-if="drill?.key === r.key" class="drill">
              <td colspan="11">
                <p class="label">{{ t('contentQuality.drill') }}</p>
                <table v-if="people.length" class="inner">
                  <thead>
                    <tr>
                      <th>{{ t('frame.col.full_name') }}</th>
                      <th>{{ t('frame.col.position') }}</th>
                      <th>{{ t('frame.col.city') }}</th>
                      <th>{{ t('frame.col.unit') }}</th>
                      <th>{{ t('contentQuality.col.reportedAt') }}</th>
                      <th>{{ t('contentQuality.col.issueStatus') }}</th>
                    </tr>
                  </thead>
                  <tbody>
                    <tr v-for="(p, i) in people" :key="i">
                      <td>{{ p.full_name }}</td>
                      <td>{{ p.position ?? '—' }}</td>
                      <td>{{ p.city ?? '—' }}</td>
                      <td>{{ p.unit ?? '—' }}</td>
                      <td>{{ p.assigned_at ? formatShortDate(String(p.assigned_at)) : '—' }}</td>
                      <td>{{ t(`contentIssues.status.${p.issue_status}`) }}</td>
                    </tr>
                  </tbody>
                </table>
                <p v-else class="muted">{{ t('contentQuality.drillEmpty') }}</p>
              </td>
            </tr>
          </template>
          <tr v-if="report.rows.length === 0">
            <td colspan="11" class="muted">{{ t('contentQuality.empty') }}</td>
          </tr>
        </tbody>
      </table>
    </div>
  </div>
</template>

<style scoped>
.filters { display: flex; flex-wrap: wrap; gap: var(--space-2); align-items: end; margin-bottom: var(--space-3); }
.filters label { display: grid; gap: var(--space-1); font-size: var(--font-size-body-s); font-weight: 700; }
.filters .field { width: auto; min-width: 140px; padding: var(--space-2) var(--space-3); }
.tiles { margin-bottom: var(--space-4); }
.strong { font-weight: 900; }
.linkish { font: inherit; font-weight: 700; color: var(--color-teal-ink); background: none; border: 0; padding: 0; cursor: pointer; text-align: left; }
.drill td { background: var(--color-bg); }
.inner { width: 100%; border-collapse: collapse; font-size: var(--font-size-body-s); }
.inner th, .inner td { text-align: left; padding: var(--space-1) var(--space-2); border-bottom: 1px solid var(--color-bg-line-soft); background: transparent; }
@media (max-width: 480px) {
  .filters { flex-direction: column; align-items: stretch; }
  .filters .field { width: 100%; }
}
</style>
