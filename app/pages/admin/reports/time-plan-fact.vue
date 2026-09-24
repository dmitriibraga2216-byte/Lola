<script setup lang="ts">
/**
 * «План і факт часу» — `/admin/reports/time-plan-fact` (docs/v2/37 §9.3, экран норм §5.3, форма §6.3).
 *
 * Отчёт обезличен: строка — элемент контента (урок, тест, практикум, шаг траектории), в ней
 * только норма и агрегаты факта — медиана, p25, p75, выборка, доля недостоверных вимірів. Ни
 * одного человека и детализации «кто это» нет (§2, §7.14 в). Над таблицей — жёлтая плашка
 * «Це показник якості матеріалу, а не швидкості людей», и каждый флаг отклонения подписан
 * «Сигнал якості матеріалу, не оцінка людини» (§7.14 а).
 *
 * Экран «Норми часу» (§5.3) и отчёт §9.3 — одна страница (решение Р-22.9): те же строки и те же
 * колонки; тот, кто правит контент (`course.edit`), меняет норму прямо в строке.
 */
import { CONTENT_TIME_DEVIATION_FLAGS, LEARNING_TIME_SUBJECT_TYPES } from '#shared/enums'
import type { LearningTimeSubjectType } from '#shared/enums'
import type { TimeNorm, TimePlanFactReport, TimePlanFactRow, TimePlanFactTrack } from '#shared/schemas/timeNorms'

definePageMeta({ layout: 'admin', middleware: 'admin-scope', requiredAnyScope: ['time.metrics.view', 'course.edit'] })

const { t } = useI18n()
const { api } = useApi()
const { hasScope } = useAuth()
const { formatNumber, formatDateTime } = useFormat()
const route = useRoute()

const filters = reactive({
  subjectType: typeof route.query.subjectType === 'string' ? route.query.subjectType : '',
  subjectId: typeof route.query.subjectId === 'string' ? route.query.subjectId : '',
  trackId: '',
  deviation: '',
  minSample: '' as string | number,
  from: '',
  to: '',
})
const report = ref<TimePlanFactReport | null>(null)
const tracks = ref<TimePlanFactTrack[]>([])
const editing = ref<string | null>(null)
const error = ref('')
const busy = ref(false)
const canEdit = computed(() => hasScope('course.edit'))

function query(extra: Record<string, string> = {}) {
  const q: Record<string, string> = { ...extra }
  for (const k of ['subjectType', 'subjectId', 'trackId', 'deviation', 'from', 'to'] as const) if (filters[k]) q[k] = String(filters[k])
  if (filters.minSample !== '' && filters.minSample !== null) q.minSample = String(filters.minSample)
  return q
}

async function load() {
  busy.value = true
  error.value = ''
  try {
    report.value = await api<TimePlanFactReport>('/reports/time-plan-fact', { query: query() })
    // Треки фильтра — из строк отчёта: курсы и траектории, где элементы действительно проходили
    const seen = new Map(tracks.value.map(tr => [tr.id, tr]))
    for (const r of report.value.rows) for (const tr of r.tracks) seen.set(tr.id, tr)
    tracks.value = [...seen.values()].sort((a, b) => a.title.localeCompare(b.title))
    // Пришли по ссылке из уведомления — форма нормы этого элемента сразу открыта
    if (canEdit.value && filters.subjectId && report.value.rows.length === 1) editing.value = report.value.rows[0]!.key
  }
  catch (err) { error.value = apiErrorOf(err).message }
  finally { busy.value = false }
}
onMounted(load)

function resetElement() {
  filters.subjectId = ''
  load()
}

function onSaved(_n: TimeNorm) {
  load()
}

const exportUrl = computed(() => `/api/v1/reports/time-plan-fact?${new URLSearchParams({ ...query(), format: 'xlsx' }).toString()}`)
const mins = (s: number | null) => (s === null ? '—' : t('timeNorms.minutes', { n: formatNumber(s / 60, { maximumFractionDigits: 1 }) }))
const share = (v: number | null) => (v === null ? '—' : formatNumber(v, { style: 'percent', maximumFractionDigits: 0 }))
const badgeOf = (r: TimePlanFactRow) => (r.deviation === 'none' ? 'teal' : r.deviation === 'no_data' ? 'muted' : 'sun')
const typeLabel = (s: LearningTimeSubjectType) => t(`timeNorms.type.${s}`)
</script>

<template>
  <div>
    <PageHeader :title="t('timeNorms.title')" :subtitle="t('timeNorms.hint')">
      <template #actions>
        <a v-if="hasScope('report.export')" class="btn ghost" :href="exportUrl">{{ t('timeNorms.filter.export') }}</a>
      </template>
    </PageHeader>

    <p class="note sun banner" role="note">{{ t('timeNorms.banner') }}</p>

    <form class="filters" @submit.prevent="load">
      <label>{{ t('timeNorms.filter.type') }}
        <select v-model="filters.subjectType" class="field">
          <option value="">{{ t('timeNorms.filter.anyType') }}</option>
          <option v-for="k in LEARNING_TIME_SUBJECT_TYPES" :key="k" :value="k">{{ typeLabel(k) }}</option>
        </select>
      </label>
      <label>{{ t('timeNorms.filter.track') }}
        <select v-model="filters.trackId" class="field">
          <option value="">{{ t('timeNorms.filter.anyTrack') }}</option>
          <option v-for="tr in tracks" :key="tr.id" :value="tr.id">{{ tr.title }}</option>
        </select>
      </label>
      <label>{{ t('timeNorms.filter.deviation') }}
        <select v-model="filters.deviation" class="field">
          <option value="">{{ t('timeNorms.filter.anyDeviation') }}</option>
          <option v-for="k in CONTENT_TIME_DEVIATION_FLAGS" :key="k" :value="k">{{ t(`timeNorms.deviation.${k}`) }}</option>
        </select>
      </label>
      <label>{{ t('timeNorms.filter.minSample') }}
        <input v-model="filters.minSample" class="field narrow" type="number" min="0" step="1" inputmode="numeric">
      </label>
      <label>{{ t('timeNorms.filter.from') }} <input v-model="filters.from" class="field" type="date"></label>
      <label>{{ t('timeNorms.filter.to') }} <input v-model="filters.to" class="field" type="date"></label>
      <button class="btn primary" type="submit" :disabled="busy">{{ t('timeNorms.filter.apply') }}</button>
      <button v-if="filters.subjectId" class="btn ghost" type="button" @click="resetElement">{{ t('timeNorms.editor.close') }}</button>
    </form>

    <p v-if="error" class="note coral" role="alert">{{ error }}</p>

    <section v-if="report" class="tiles" :aria-label="t('timeNorms.title')">
      <div class="tile"><span>{{ t('timeNorms.summary.elements') }}</span><b>{{ report.summary.elements }}</b></div>
      <div class="tile"><span>{{ t('timeNorms.summary.tooSlow') }}</span><b>{{ report.summary.tooSlow }}</b></div>
      <div class="tile"><span>{{ t('timeNorms.summary.tooFast') }}</span><b>{{ report.summary.tooFast }}</b></div>
      <div class="tile"><span>{{ t('timeNorms.summary.noData') }}</span><b>{{ report.summary.noData }}</b></div>
    </section>
    <p v-if="report" class="muted computed">{{ t('timeNorms.computedAt', { at: formatDateTime(report.computedAt) }) }}</p>

    <div v-if="report" class="table-wrap">
      <table class="table" :aria-busy="busy">
        <thead>
          <tr>
            <th>{{ t('timeNorms.col.element') }}</th>
            <th>{{ t('timeNorms.col.type') }}</th>
            <th>{{ t('timeNorms.col.track') }}</th>
            <th class="num">{{ t('timeNorms.col.planned') }}</th>
            <th>{{ t('timeNorms.col.source') }}</th>
            <th class="num">{{ t('timeNorms.col.median') }}</th>
            <th class="num">{{ t('timeNorms.col.p25') }}</th>
            <th class="num">{{ t('timeNorms.col.p75') }}</th>
            <th class="num">{{ t('timeNorms.col.sample') }}</th>
            <th>{{ t('timeNorms.col.deviation') }}</th>
            <th class="num">{{ t('timeNorms.col.unreliable') }}</th>
            <th v-if="canEdit">{{ t('timeNorms.col.actions') }}</th>
          </tr>
        </thead>
        <tbody>
          <template v-for="r in report.rows" :key="r.key">
            <tr>
              <td class="strong">{{ r.title }}</td>
              <td>{{ typeLabel(r.subjectType) }}</td>
              <td>{{ r.tracks.map(tr => tr.title).join(', ') || '—' }}</td>
              <td class="num">{{ mins(r.plannedSeconds) }}</td>
              <td>{{ t(`timeNorms.source.${r.source}`) }}</td>
              <td class="num">{{ mins(r.medianSeconds) }}</td>
              <td class="num">{{ mins(r.p25Seconds) }}</td>
              <td class="num">{{ mins(r.p75Seconds) }}</td>
              <td class="num">{{ r.sample }}</td>
              <td>
                <span class="badge" :class="badgeOf(r)">{{ t(`timeNorms.deviation.${r.deviation}`) }}</span>
                <template v-if="r.factor !== null"> {{ t('timeNorms.factor', { n: formatNumber(r.factor, { maximumFractionDigits: 1 }) }) }}</template>
                <small v-if="r.deviation === 'too_slow' || r.deviation === 'too_fast'" class="muted signal">{{ t('timeNorms.signal') }}</small>
              </td>
              <td class="num">{{ share(r.unreliableShare) }}</td>
              <td v-if="canEdit">
                <button class="btn small ghost" type="button" :aria-expanded="editing === r.key" @click="editing = editing === r.key ? null : r.key">
                  {{ editing === r.key ? t('timeNorms.editor.close') : t('timeNorms.editor.open') }}
                </button>
              </td>
            </tr>
            <tr v-if="canEdit && editing === r.key" class="edit">
              <td :colspan="12">
                <TimeNormEditor :subject-type="r.subjectType" :subject-id="r.subjectId" @saved="onSaved" />
              </td>
            </tr>
          </template>
          <tr v-if="report.rows.length === 0">
            <td :colspan="canEdit ? 12 : 11" class="muted">{{ t('timeNorms.empty') }}</td>
          </tr>
        </tbody>
      </table>
    </div>
  </div>
</template>

<style scoped>
.banner { margin-bottom: var(--space-3); }
.filters { display: flex; flex-wrap: wrap; gap: var(--space-2); align-items: end; margin-bottom: var(--space-3); }
.filters label { display: grid; gap: var(--space-1); font-size: var(--font-size-body-s); font-weight: 700; }
.filters .field { width: auto; min-width: 140px; padding: var(--space-2) var(--space-3); }
.filters .field.narrow { min-width: 0; width: 96px; }
.tiles { margin-bottom: var(--space-2); }
.computed { margin: 0 0 var(--space-3); font-size: var(--font-size-body-s); }
.strong { font-weight: 700; }
.signal { display: block; margin-top: var(--space-1); }
.edit td { background: var(--color-bg); }
@media (max-width: 480px) {
  .filters { flex-direction: column; align-items: stretch; }
  .filters .field, .filters .field.narrow { width: 100%; }
}
</style>
