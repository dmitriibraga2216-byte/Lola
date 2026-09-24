<script setup lang="ts">
/**
 * «Звіт про помилки» — `/admin/content-issues` (docs/v2/36 §5.3, §14).
 *
 * Как на эталоне: самостоятельный экран, фильтр «Тип» первым, колонка «Трек» обязательна —
 * по ней методист понимает, чей это контент, раньше, чем откроет карточку. Сортировка —
 * сервера (`reports_count desc, last_reported_at desc`): сначала то, на что жалуются многие.
 * Видимость тоже решает сервер: администратор видит всё, методист — свой контент, керівник
 * точки — скарги со своих точек (§2).
 */
import { CONTENT_ISSUE_TARGET_TYPES, CONTENT_ISSUE_TYPES } from '#shared/enums'
import { CONTENT_ISSUE_PAGE_SIZES, CONTENT_ISSUE_QUEUE_TABS } from '#shared/schemas/contentIssues'
import type { ContentIssueQueue, ContentIssueQueueRow, ContentIssueQueueTab } from '#shared/schemas/contentIssues'

definePageMeta({ layout: 'admin', middleware: 'admin-scope', requiredScope: 'content_issue.view' })

const { t } = useI18n()
const { api } = useApi()
const { hasScope } = useAuth()
const { formatShortDate } = useFormat()

interface Option { id: string, name: string }

const tab = ref<ContentIssueQueueTab>('new')
const filters = reactive({
  issueType: '',
  targetType: '',
  courseId: '',
  assigneeId: '',
  locationId: '',
  from: '',
  to: '',
  affectsScoring: false,
})
/** Курсоры пройденных страниц: первая — без курсора; «Далі» кладёт курсор от сервера, «Назад» снимает. */
const cursors = ref<string[]>([''])
const nextCursor = ref<string | null>(null)
const limit = ref<number>(25)
const rows = ref<ContentIssueQueueRow[]>([])
const total = ref(0)
const loading = ref(true)
const failed = ref(false)

const courses = ref<Option[]>([])
const people = ref<Option[]>([])
const locations = ref<Option[]>([])

async function load() {
  loading.value = true
  failed.value = false
  try {
    const cursor = cursors.value.at(-1)
    const query: Record<string, unknown> = { tab: tab.value, limit: limit.value, ...(cursor ? { cursor } : {}) }
    for (const [k, v] of Object.entries(filters)) if (v) query[k] = v === true ? 'true' : v
    const res = await api<ContentIssueQueue>('/content-issues', { query })
    rows.value = res.items
    total.value = res.total
    nextCursor.value = res.nextCursor
  }
  catch {
    failed.value = true
    rows.value = []
  }
  finally { loading.value = false }
}

async function loadOptions() {
  const [c, p, l] = await Promise.all([
    api<{ id: string, title: string }[]>('/courses').catch(() => []),
    api<{ id: string, fullName: string }[]>('/people', { query: { limit: 300 } }).catch(() => []),
    api<{ id: string, name: string }[]>('/refs/locations').catch(() => []),
  ])
  courses.value = c.map(x => ({ id: x.id, name: x.title }))
  people.value = p.map(x => ({ id: x.id, name: x.fullName }))
  locations.value = l.map(x => ({ id: x.id, name: x.name }))
}

function firstPage() {
  cursors.value = ['']
  load()
}
function nextPage() {
  if (!nextCursor.value) return
  cursors.value = [...cursors.value, nextCursor.value]
  load()
}
function prevPage() {
  if (cursors.value.length <= 1) return
  cursors.value = cursors.value.slice(0, -1)
  load()
}

onMounted(() => { load(); loadOptions() })
watch([tab, limit], firstPage)
watch(filters, firstPage, { deep: true })

function resetFilters() {
  Object.assign(filters, { issueType: '', targetType: '', courseId: '', assigneeId: '', locationId: '', from: '', to: '', affectsScoring: false })
}

const firstRow = computed(() => total.value ? (cursors.value.length - 1) * limit.value + 1 : 0)
const lastRow = computed(() => Math.min((cursors.value.length - 1) * limit.value + rows.value.length, total.value))
const dateOf = (v: string | null) => v ? formatShortDate(v) : '—'
</script>

<template>
  <div>
    <PageHeader :title="t('contentIssues.title')" :subtitle="t('contentIssues.hint')">
      <template #actions>
        <NuxtLink v-if="hasScope('content_issue.triage')" class="btn ghost" to="/admin/content-issues/routing">{{ t('contentIssues.routingLink') }}</NuxtLink>
        <NuxtLink class="btn ghost" to="/admin/reports/content-quality">{{ t('contentIssues.qualityLink') }}</NuxtLink>
      </template>
    </PageHeader>

    <div class="chips tabs" role="group" :aria-label="t('contentIssues.col.status')">
      <button
        v-for="k in CONTENT_ISSUE_QUEUE_TABS" :key="k" type="button"
        :class="['chip', { on: tab === k }]" :aria-pressed="tab === k" @click="tab = k"
      >
        {{ t(`contentIssues.tab.${k}`) }}
      </button>
    </div>

    <form class="filters" @submit.prevent>
      <label>{{ t('contentIssues.filter.type') }}
        <select v-model="filters.issueType" class="field">
          <option value="">{{ t('contentIssues.filter.anyType') }}</option>
          <option v-for="k in CONTENT_ISSUE_TYPES" :key="k" :value="k">{{ t(`issue.type.${k}`) }}</option>
        </select>
      </label>
      <label>{{ t('contentIssues.filter.targetType') }}
        <select v-model="filters.targetType" class="field">
          <option value="">{{ t('contentIssues.filter.anyType') }}</option>
          <option v-for="k in CONTENT_ISSUE_TARGET_TYPES" :key="k" :value="k">{{ t(`contentIssues.target.${k}`) }}</option>
        </select>
      </label>
      <label v-if="courses.length">{{ t('contentIssues.filter.track') }}
        <select v-model="filters.courseId" class="field">
          <option value="">{{ t('contentIssues.filter.anyTrack') }}</option>
          <option v-for="c in courses" :key="c.id" :value="c.id">{{ c.name }}</option>
        </select>
      </label>
      <label v-if="people.length">{{ t('contentIssues.filter.assignee') }}
        <select v-model="filters.assigneeId" class="field">
          <option value="">{{ t('contentIssues.filter.anyAssignee') }}</option>
          <option v-for="p in people" :key="p.id" :value="p.id">{{ p.name }}</option>
        </select>
      </label>
      <label v-if="locations.length">{{ t('contentIssues.filter.location') }}
        <select v-model="filters.locationId" class="field">
          <option value="">{{ t('contentIssues.filter.anyLocation') }}</option>
          <option v-for="l in locations" :key="l.id" :value="l.id">{{ l.name }}</option>
        </select>
      </label>
      <label>{{ t('contentIssues.filter.from') }} <input v-model="filters.from" class="field" type="date"></label>
      <label>{{ t('contentIssues.filter.to') }} <input v-model="filters.to" class="field" type="date"></label>
      <label class="check"><input v-model="filters.affectsScoring" type="checkbox"> {{ t('contentIssues.filter.affectsScoring') }}</label>
      <button class="btn ghost small" type="button" @click="resetFilters">{{ t('contentIssues.filter.reset') }}</button>
    </form>

    <div v-if="failed" class="note coral state" role="alert">
      <p>{{ t('contentIssues.loadError') }}</p>
      <button class="btn ghost small" type="button" @click="load">{{ t('contentIssues.retry') }}</button>
    </div>

    <div v-else class="table-wrap">
      <table class="table" :aria-busy="loading">
        <thead>
          <tr>
            <th>{{ t('contentIssues.col.type') }}</th>
            <th>{{ t('contentIssues.col.element') }}</th>
            <th>{{ t('contentIssues.col.track') }}</th>
            <th class="num">{{ t('contentIssues.col.reports') }}</th>
            <th>{{ t('contentIssues.col.status') }}</th>
            <th>{{ t('contentIssues.col.assignee') }}</th>
            <th>{{ t('contentIssues.col.lastReport') }}</th>
            <th>{{ t('contentIssues.col.due') }}</th>
          </tr>
        </thead>
        <tbody v-if="loading">
          <tr v-for="n in 10" :key="n" class="skeleton" aria-hidden="true">
            <td v-for="c in 8" :key="c"><span class="bar" /></td>
          </tr>
        </tbody>
        <tbody v-else>
          <tr v-for="r in rows" :key="r.id" :class="{ overdue: r.overdue }">
            <td>{{ t(`issue.type.${r.issueType}`) }}</td>
            <td>
              <NuxtLink :to="`/admin/content-issues/${r.id}`" class="link">{{ r.title }}</NuxtLink>
              <span class="sub">
                {{ t(`contentIssues.target.${r.targetType}`) }}
                <template v-if="r.affectsScoring"> · {{ t('contentIssues.affects') }}</template>
                <template v-if="r.trusted"> · {{ t('contentIssues.trusted') }}</template>
              </span>
            </td>
            <td>{{ r.tracks.map(tr => tr.title).join(', ') || '—' }}</td>
            <td class="num">{{ r.reportsCount }}</td>
            <td><span :class="['badge', `st-${r.status}`]">{{ t(`contentIssues.status.${r.status}`) }}</span></td>
            <td>
              <template v-if="r.assignee">
                {{ r.assignee.fullName }}
                <span v-if="!r.assignee.active" class="sub">{{ t('contentIssues.inactive') }}</span>
              </template>
              <span v-else class="faint">{{ t('contentIssues.unassigned') }}</span>
            </td>
            <td class="nowrap">{{ dateOf(r.lastReportedAt) }}</td>
            <td :class="['nowrap', { 'due-late': r.overdue }]">
              {{ dateOf(r.dueAt) }}
              <span v-if="r.overdue" class="sub">{{ t('contentIssues.overdue') }}</span>
            </td>
          </tr>
          <tr v-if="rows.length === 0">
            <td colspan="8">
              {{ t('contentIssues.empty') }}
              <NuxtLink class="link" to="/admin/reports/content-quality">{{ t('contentIssues.emptyLink') }}</NuxtLink>
            </td>
          </tr>
        </tbody>
      </table>
    </div>

    <nav v-if="!failed && total > 0" class="pager" :aria-label="t('contentIssues.perPage')">
      <label>{{ t('contentIssues.perPage') }}
        <select v-model.number="limit" class="field">
          <option v-for="n in CONTENT_ISSUE_PAGE_SIZES" :key="n" :value="n">{{ n }}</option>
        </select>
      </label>
      <span class="muted">{{ t('contentIssues.pageOf', { from: firstRow, to: lastRow, total }) }}</span>
      <button class="btn ghost small" type="button" :disabled="cursors.length <= 1 || loading" @click="prevPage">{{ t('contentIssues.prev') }}</button>
      <button class="btn ghost small" type="button" :disabled="!nextCursor || loading" @click="nextPage">{{ t('contentIssues.next') }}</button>
    </nav>
  </div>
</template>

<style scoped>
.tabs { margin-bottom: var(--space-3); }
.filters { display: flex; flex-wrap: wrap; gap: var(--space-2); align-items: end; margin-bottom: var(--space-3); }
.filters label { display: grid; gap: var(--space-1); font-size: var(--font-size-body-s); font-weight: 700; }
.filters .field { width: auto; min-width: 140px; padding: var(--space-2) var(--space-3); }
.filters .check { display: flex; align-items: center; gap: var(--space-2); }
.state { display: flex; flex-wrap: wrap; align-items: center; justify-content: space-between; gap: var(--space-2); }
.state p { margin: 0; }
.nowrap { white-space: nowrap; }
.st-new { background: var(--color-sun-soft); color: var(--color-sun-ink); }
.st-in_progress, .st-deferred { background: var(--color-sun); color: var(--color-sun-ink); }
.st-fixed, .st-closed { background: var(--color-teal); color: var(--color-teal-deep); }
.st-rejected { background: var(--color-bg-line-soft); color: var(--color-ink-muted); }
tr.overdue td { background: var(--color-coral-soft); }
.due-late { color: var(--color-coral-ink); font-weight: 800; }
.skeleton .bar { display: block; height: var(--space-3); border-radius: var(--radius-pill); background: var(--color-bg-line-soft); }
.pager { display: flex; flex-wrap: wrap; gap: var(--space-2); align-items: center; justify-content: flex-end; margin-top: var(--space-3); }
.pager label { display: flex; gap: var(--space-2); align-items: center; font-size: var(--font-size-body-s); font-weight: 700; }
.pager .field { width: auto; padding: var(--space-1) var(--space-3); }
@media (max-width: 480px) {
  .filters { flex-direction: column; align-items: stretch; }
  .filters .field { width: 100%; }
  .pager { justify-content: flex-start; }
}
</style>
