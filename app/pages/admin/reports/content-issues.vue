<script setup lang="ts">
/**
 * Четыре отчёта модуля жалоб — `/admin/reports/content-issues` (docs/v2/36 §9) рядом
 * с «Якість контенту»: «Скарги» (плоская выгрузка, CSV и XLSX), «Дисципліна авторів»,
 * «Проблемні питання» и «Заявники» — последняя вкладка только администратору (`content_issue.mute`).
 * Всё считает сервер; экран показывает строки и отдаёт выгрузку теми же фильтрами.
 */
import { CONTENT_ISSUE_STATUSES, CONTENT_ISSUE_TYPES } from '#shared/enums'
import type {
  AuthorDisciplineRow, ComplaintRow, ContentIssueReportKind, ProblemQuestionRow, ReporterRow,
} from '#shared/schemas/contentIssues'

definePageMeta({ layout: 'admin', middleware: 'admin-scope', requiredScope: 'content_issue.view' })

const { t } = useI18n()
const { api } = useApi()
const { hasScope } = useAuth()
const { formatShortDate, formatNumber } = useFormat()

const tabs = computed<ContentIssueReportKind[]>(() => hasScope('content_issue.mute')
  ? ['complaints', 'authors', 'questions', 'reporters']
  : ['complaints', 'authors', 'questions'])
const tab = ref<ContentIssueReportKind>('complaints')

const filters = reactive({
  from: new Date(Date.now() - 90 * 86_400_000).toISOString().slice(0, 10),
  to: new Date().toISOString().slice(0, 10),
  issueType: '',
  status: '',
})
const rows = ref<unknown[] | null>(null)
const error = ref(false)
const busy = ref(false)

function query(): Record<string, string> {
  const q: Record<string, string> = {}
  if (filters.from) q.from = filters.from
  if (filters.to) q.to = filters.to
  if (filters.issueType) q.issueType = filters.issueType
  if (filters.status) q.status = filters.status
  return q
}

async function load() {
  busy.value = true
  error.value = false
  rows.value = null
  try { rows.value = (await api<{ rows: unknown[] }>(`/reports/content-issues/${tab.value}`, { query: query() })).rows }
  catch { error.value = true }
  finally { busy.value = false }
}
onMounted(load)
watch(tab, load)

const exportUrl = (format: 'xlsx' | 'csv') => `/api/v1/reports/content-issues/${tab.value}?${new URLSearchParams({ ...query(), format }).toString()}`
const num = (v: number | null) => v === null ? '—' : formatNumber(v, { maximumFractionDigits: 1 })
const date = (v: string | null) => v ? formatShortDate(v) : '—'

const complaints = computed(() => (tab.value === 'complaints' ? rows.value : null) as ComplaintRow[] | null)
const authors = computed(() => (tab.value === 'authors' ? rows.value : null) as AuthorDisciplineRow[] | null)
const questions = computed(() => (tab.value === 'questions' ? rows.value : null) as ProblemQuestionRow[] | null)
const reporters = computed(() => (tab.value === 'reporters' ? rows.value : null) as ReporterRow[] | null)
const rescoreLabel = (s: string) => s === 'mixed' ? t('contentIssueReports.rescoreMixed') : t(`contentIssues.rescoreState.${s}`)
</script>

<template>
  <div>
    <PageHeader :title="t('contentIssueReports.title')" :subtitle="t('contentIssueReports.hint')">
      <template #actions>
        <a v-if="hasScope('report.export') && tab === 'complaints'" class="btn ghost" :href="exportUrl('csv')">{{ t('contentIssueReports.exportCsv') }}</a>
        <a v-if="hasScope('report.export')" class="btn ghost" :href="exportUrl('xlsx')">{{ t('contentIssueReports.exportXlsx') }}</a>
      </template>
    </PageHeader>

    <div class="chips tabs" role="tablist">
      <button
        v-for="k in tabs" :key="k" type="button" role="tab" :aria-selected="tab === k"
        :class="['chip', { on: tab === k }]" @click="tab = k"
      >
        {{ t(`contentIssueReports.tab.${k}`) }}
      </button>
    </div>

    <form class="filters" @submit.prevent="load">
      <div class="date-label"><label for="dt-filters-from">{{ t('contentIssueReports.from') }}</label> <input id="dt-filters-from" v-model="filters.from" class="field" type="date"></div>
      <div class="date-label"><label for="dt-filters-to">{{ t('contentIssueReports.to') }}</label> <input id="dt-filters-to" v-model="filters.to" class="field" type="date"></div>
      <label>{{ t('contentIssues.filter.type') }}
        <select v-model="filters.issueType" class="field">
          <option value="">{{ t('contentIssues.filter.anyType') }}</option>
          <option v-for="k in CONTENT_ISSUE_TYPES" :key="k" :value="k">{{ t(`issue.type.${k}`) }}</option>
        </select>
      </label>
      <label v-if="tab === 'complaints'">{{ t('contentIssueReports.col.status') }}
        <select v-model="filters.status" class="field">
          <option value="">{{ t('contentIssueReports.anyStatus') }}</option>
          <option v-for="k in CONTENT_ISSUE_STATUSES" :key="k" :value="k">{{ t(`contentIssues.status.${k}`) }}</option>
        </select>
      </label>
      <button class="btn primary" type="submit" :disabled="busy">{{ t('contentIssueReports.apply') }}</button>
    </form>

    <div v-if="error" class="note coral" role="alert">
      {{ t('contentIssues.loadError') }}
      <button type="button" class="btn ghost" @click="load">{{ t('contentIssueReports.retry') }}</button>
    </div>
    <p v-else-if="!rows" class="muted" aria-busy="true">{{ t('contentIssueReports.loading') }}</p>
    <p v-else-if="rows.length === 0" class="muted">{{ t('contentIssueReports.empty') }}</p>

    <div v-else-if="complaints" class="table-wrap">
      <table class="table">
        <thead>
          <tr>
            <th>{{ t('contentIssueReports.col.reportedAt') }}</th>
            <th>{{ t('contentIssueReports.col.type') }}</th>
            <th>{{ t('contentIssueReports.col.element') }}</th>
            <th>{{ t('contentIssueReports.col.track') }}</th>
            <th class="num">{{ t('contentIssueReports.col.version') }}</th>
            <th class="num">{{ t('contentIssueReports.col.reporters') }}</th>
            <th>{{ t('contentIssueReports.col.status') }}</th>
            <th>{{ t('contentIssueReports.col.resolution') }}</th>
            <th>{{ t('contentIssueReports.col.assignee') }}</th>
            <th>{{ t('contentIssueReports.col.dueAt') }}</th>
            <th>{{ t('contentIssueReports.col.overdue') }}</th>
            <th>{{ t('contentIssueReports.col.rescore') }}</th>
          </tr>
        </thead>
        <tbody>
          <tr v-for="r in complaints" :key="r.id">
            <td>{{ date(r.reportedAt) }}</td>
            <td>{{ t(`issue.type.${r.issueType}`) }}</td>
            <td><NuxtLink :to="`/admin/content-issues/${r.id}`">{{ r.title }}</NuxtLink></td>
            <td>{{ r.tracks.map(tr => tr.title).join(', ') || '—' }}</td>
            <td class="num">{{ r.contentVersion }}</td>
            <td class="num">{{ r.reporters }}</td>
            <td>{{ t(`contentIssues.status.${r.status}`) }}</td>
            <td>{{ r.resolution ? t(`contentIssues.resolution.${r.resolution}`) : '—' }}</td>
            <td>{{ r.assignee ?? t('contentIssueReports.unassigned') }}</td>
            <td>{{ date(r.dueAt) }}</td>
            <td :class="{ coral: (r.overdueDays ?? 0) > 0 }">{{ r.overdueDays ? t('contentIssueReports.overdueDays', { n: r.overdueDays }) : '—' }}</td>
            <td>{{ rescoreLabel(r.rescoreState) }}</td>
          </tr>
        </tbody>
      </table>
    </div>

    <div v-else-if="authors" class="table-wrap">
      <table class="table">
        <thead>
          <tr>
            <th>{{ t('contentIssueReports.col.assignee') }}</th>
            <th class="num">{{ t('contentIssueReports.col.open') }}</th>
            <th class="num">{{ t('contentIssueReports.col.overdueNow') }}</th>
            <th class="num">{{ t('contentIssueReports.col.decided') }}</th>
            <th class="num">{{ t('contentIssueReports.col.avgDays') }}</th>
            <th class="num">{{ t('contentIssueReports.col.rejectedPct') }}</th>
          </tr>
        </thead>
        <tbody>
          <tr v-for="r in authors" :key="r.assigneeId ?? 'none'">
            <td>
              {{ r.name ?? t('contentIssueReports.unassigned') }}
              <span v-if="r.active === false" class="muted">· {{ t('contentIssueReports.inactive') }}</span>
            </td>
            <td class="num">{{ r.open }}</td>
            <td :class="['num', { coral: r.overdue > 0 }]">{{ r.overdue }}</td>
            <td class="num">{{ r.decided }}</td>
            <td class="num">{{ num(r.avgDaysToFix) }}</td>
            <td class="num">{{ num(r.rejectedPct) }}</td>
          </tr>
        </tbody>
      </table>
    </div>

    <div v-else-if="questions" class="table-wrap">
      <table class="table">
        <thead>
          <tr>
            <th>{{ t('contentIssueReports.col.question') }}</th>
            <th>{{ t('contentIssueReports.col.quizzes') }}</th>
            <th class="num">{{ t('contentIssueReports.col.complaints') }}</th>
            <th class="num">{{ t('contentIssueReports.col.answers') }}</th>
            <th class="num">{{ t('contentIssueReports.col.wrongPct') }}</th>
            <th>{{ t('contentIssueReports.col.rescore') }}</th>
          </tr>
        </thead>
        <tbody>
          <tr v-for="r in questions" :key="r.questionId">
            <td>
              {{ r.title }}
              <span v-if="r.suspect" class="badge coral">{{ t('contentIssueReports.suspect') }}</span>
            </td>
            <td>{{ r.quizzes.map(z => z.title).join(', ') || '—' }}</td>
            <td class="num">{{ r.complaints }}</td>
            <td class="num">{{ r.answers }}</td>
            <td :class="['num', { coral: r.suspect }]">{{ num(r.wrongPct) }}</td>
            <td>{{ rescoreLabel(r.rescoreState) }}</td>
          </tr>
        </tbody>
      </table>
    </div>

    <div v-else-if="reporters" class="table-wrap">
      <table class="table">
        <thead>
          <tr>
            <th>{{ t('contentIssueReports.col.person') }}</th>
            <th>{{ t('contentIssueReports.col.location') }}</th>
            <th class="num">{{ t('contentIssueReports.col.reports') }}</th>
            <th class="num">{{ t('contentIssueReports.col.confirmed') }}</th>
            <th class="num">{{ t('contentIssueReports.col.rejected') }}</th>
            <th class="num">{{ t('contentIssueReports.col.spam') }}</th>
            <th class="num">{{ t('contentIssueReports.col.confirmedPct') }}</th>
            <th>{{ t('contentIssueReports.col.muted') }}</th>
          </tr>
        </thead>
        <tbody>
          <tr v-for="r in reporters" :key="r.userId">
            <td>
              {{ r.fullName }}
              <span v-if="r.trusted" class="badge teal">{{ t('contentIssueReports.trusted') }}</span>
            </td>
            <td>{{ r.location ?? '—' }}</td>
            <td class="num">{{ r.reports }}</td>
            <td class="num">{{ r.confirmed }}</td>
            <td class="num">{{ r.rejected }}</td>
            <td class="num">{{ r.spam }}</td>
            <td class="num">{{ num(r.confirmedPct) }}</td>
            <td :class="{ coral: !!r.mutedUntil }">{{ date(r.mutedUntil) }}</td>
          </tr>
        </tbody>
      </table>
    </div>
  </div>
</template>

<style scoped>
.tabs { margin-bottom: var(--space-3); }
.filters { display: flex; flex-wrap: wrap; gap: var(--space-2); align-items: end; margin-bottom: var(--space-3); }
.filters label, .filters .date-label { display: grid; gap: var(--space-1); font-size: var(--font-size-body-s); font-weight: 700; }
.filters .field { width: auto; min-width: 140px; padding: var(--space-2) var(--space-3); }
.coral { color: var(--color-coral-deep); font-weight: 800; }
.badge { font-size: var(--font-size-body-s); font-weight: 700; border-radius: var(--radius-pill); padding: 0 var(--space-2); margin-left: var(--space-1); white-space: nowrap; }
.badge.coral { background: var(--color-coral); color: var(--color-coral-deep); }
.badge.teal { background: var(--color-teal); color: var(--color-teal-deep); }
@media (max-width: 480px) {
  .filters { flex-direction: column; align-items: stretch; }
  .filters .field { width: 100%; }
}
</style>
