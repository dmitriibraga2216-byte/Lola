<script setup lang="ts">
/**
 * Звіти ШІ — `/admin/reports/ai` (docs/v2/30 §9.3–§9.5): «Якість моделі», «Допомога
 * перевіряючому», «Вартість ШІ». Скоуп `ai.audit` (§2); вивантаження — ті самі рядки файлом
 * (`report.export`, docs/22 §7).
 *
 * Звіти — про програму, а не про людей (інваріант 18): якість — у розрізі версії промпту й
 * критерію, без кандидатів; частки рахуються від рішень людини, і при малій вибірці рядок
 * позначено «мало рішень» — висновків з нього не робити. Версії промпту між собою не
 * порівнюються (§7.16).
 */
import { AI_PURPOSES } from '#shared/enums'

definePageMeta({ layout: 'admin', middleware: 'admin-scope', requiredScope: 'ai.audit' })

type Name = 'quality' | 'review-help' | 'cost'
interface QualityBase { promptVersion: string, scores: number, decided: number, matchPct: number | null, minorPct: number | null, majorPct: number | null, avgConfidence: number | null, smallSample: boolean }
interface Quality { rows: (QualityBase & { sessions: number, needsHumanPct: number | null })[], criteria: (QualityBase & { criterion: string, scenario: string })[] }
interface ReviewHelp { rows: { reviewerId: string, reviewer: string, reviews: number, hints: number, shown: number, match: number, minor: number, major: number, notShown: number, matchPct: number | null, avgMinWithHint: number | null, avgMinWithoutHint: number | null }[] }
interface CostRow { day?: string, purpose: string, currency: string, calls: number, tokensIn: number, tokensOut: number, costMinor: number, avgLatencyMs: number | null, errorPct: number | null }
interface Cost { rows: (CostRow & { day: string })[], totals: CostRow[] }

const { t } = useI18n()
const { api } = useApi()
const { hasScope } = useAuth()
const { formatNumber, formatShortDate } = useFormat()
const route = useRoute()
const router = useRouter()

const NAMES: Name[] = ['quality', 'review-help', 'cost']
const name = computed<Name>({
  get: () => (NAMES as string[]).includes(String(route.query.r)) ? route.query.r as Name : 'quality',
  set: v => router.replace({ query: { ...route.query, r: v === 'quality' ? undefined : v } }),
})

const filters = reactive({
  from: new Date(Date.now() - 30 * 86_400_000).toISOString().slice(0, 10),
  to: new Date().toISOString().slice(0, 10),
  purpose: '',
})
const quality = ref<Quality | null>(null)
const help = ref<ReviewHelp | null>(null)
const cost = ref<Cost | null>(null)
const error = ref('')
const busy = ref(false)

function query(): Record<string, string> {
  const q: Record<string, string> = {}
  if (filters.from) q.from = filters.from
  if (filters.to) q.to = filters.to
  if (name.value === 'cost' && filters.purpose) q.purpose = filters.purpose
  return q
}

async function load() {
  busy.value = true
  error.value = ''
  try {
    const r = await api<unknown>(`/reports/ai/${name.value}`, { query: query() })
    if (name.value === 'quality') quality.value = r as Quality
    else if (name.value === 'review-help') help.value = r as ReviewHelp
    else cost.value = r as Cost
  }
  catch (err) { error.value = apiErrorOf(err).message }
  finally { busy.value = false }
}
onMounted(load)
watch(name, load)

const exportUrl = (format: 'xlsx' | 'csv') => `/api/v1/reports/ai/${name.value}?${new URLSearchParams({ ...query(), format }).toString()}`
const pct = (v: number | null) => (v === null ? '—' : `${formatNumber(v, { maximumFractionDigits: 1 })} %`)
const num = (v: number | null, digits = 1) => (v === null ? '—' : formatNumber(v, { maximumFractionDigits: digits }))
const money = (minor: number, currency: string) => `${formatNumber(minor / 100, { minimumFractionDigits: 2, maximumFractionDigits: 2 })} ${currency}`
const version = (v: string) => v || t('aiReports.unknownVersion')
</script>

<template>
  <div>
    <PageHeader :title="t('aiReports.title')" :subtitle="t('aiReports.hint')">
      <template #actions>
        <template v-if="hasScope('report.export')">
          <a class="btn ghost" :href="exportUrl('xlsx')">{{ t('aiReports.exportXlsx') }}</a>
          <a class="btn ghost" :href="exportUrl('csv')">{{ t('aiReports.exportCsv') }}</a>
        </template>
      </template>
    </PageHeader>

    <div class="chips" role="tablist" :aria-label="t('aiReports.title')">
      <button v-for="n in NAMES" :key="n" role="tab" type="button" :aria-selected="name === n" :class="['chip', { on: name === n }]" @click="name = n">{{ t(`aiReports.tab.${n}`) }}</button>
    </div>
    <p class="sub">{{ t(`aiReports.about.${name}`) }}</p>

    <form class="filters" @submit.prevent="load">
      <label>{{ t('aiReports.from') }} <input v-model="filters.from" class="field" type="date"></label>
      <label>{{ t('aiReports.to') }} <input v-model="filters.to" class="field" type="date"></label>
      <label v-if="name === 'cost'">{{ t('aiReports.purpose') }}
        <select v-model="filters.purpose" class="field">
          <option value="">{{ t('aiReports.anyPurpose') }}</option>
          <option v-for="p in AI_PURPOSES" :key="p" :value="p">{{ t(`aiSettings.purpose.${p}`) }}</option>
        </select>
      </label>
      <button class="btn primary" type="submit" :disabled="busy">{{ t('aiReports.apply') }}</button>
    </form>

    <p v-if="error" class="note coral" role="alert">{{ error }}</p>

    <template v-if="name === 'quality' && quality">
      <p class="note sun">{{ t('aiReports.quality.note') }}</p>
      <p v-if="!quality.rows.length" class="muted">{{ t('aiReports.empty') }}</p>
      <div v-else class="table-wrap">
        <table class="table" :aria-busy="busy">
          <thead>
            <tr>
              <th>{{ t('aiReports.col.promptVersion') }}</th>
              <th class="num">{{ t('aiReports.col.scores') }}</th>
              <th class="num">{{ t('aiReports.col.decided') }}</th>
              <th class="num">{{ t('aiReports.col.match') }}</th>
              <th class="num">{{ t('aiReports.col.minor') }}</th>
              <th class="num">{{ t('aiReports.col.major') }}</th>
              <th class="num">{{ t('aiReports.col.confidence') }}</th>
              <th class="num">{{ t('aiReports.col.needsHuman') }}</th>
            </tr>
          </thead>
          <tbody>
            <tr v-for="r in quality.rows" :key="r.promptVersion">
              <td>{{ version(r.promptVersion) }}<span v-if="r.smallSample" class="sub block">{{ t('aiReports.smallSample') }}</span></td>
              <td class="num">{{ r.scores }}</td>
              <td class="num">{{ r.decided }}</td>
              <td class="num">{{ pct(r.matchPct) }}</td>
              <td class="num">{{ pct(r.minorPct) }}</td>
              <td class="num strong">{{ pct(r.majorPct) }}</td>
              <td class="num">{{ num(r.avgConfidence, 2) }}</td>
              <td class="num">{{ pct(r.needsHumanPct) }}<span class="sub block">{{ t('aiReports.ofSessions', { n: r.sessions }) }}</span></td>
            </tr>
          </tbody>
        </table>
      </div>
      <h2 v-if="quality.criteria.length" class="h2">{{ t('aiReports.quality.byCriterion') }}</h2>
      <div v-if="quality.criteria.length" class="table-wrap">
        <table class="table">
          <thead>
            <tr>
              <th>{{ t('aiReports.col.criterion') }}</th>
              <th>{{ t('aiReports.col.promptVersion') }}</th>
              <th class="num">{{ t('aiReports.col.scores') }}</th>
              <th class="num">{{ t('aiReports.col.decided') }}</th>
              <th class="num">{{ t('aiReports.col.match') }}</th>
              <th class="num">{{ t('aiReports.col.minor') }}</th>
              <th class="num">{{ t('aiReports.col.major') }}</th>
              <th class="num">{{ t('aiReports.col.confidence') }}</th>
            </tr>
          </thead>
          <tbody>
            <tr v-for="(r, i) in quality.criteria" :key="i">
              <td>{{ r.criterion }}<span class="sub block">{{ r.scenario }}</span><span v-if="r.smallSample" class="sub block">{{ t('aiReports.smallSample') }}</span></td>
              <td>{{ version(r.promptVersion) }}</td>
              <td class="num">{{ r.scores }}</td>
              <td class="num">{{ r.decided }}</td>
              <td class="num">{{ pct(r.matchPct) }}</td>
              <td class="num">{{ pct(r.minorPct) }}</td>
              <td class="num strong">{{ pct(r.majorPct) }}</td>
              <td class="num">{{ num(r.avgConfidence, 2) }}</td>
            </tr>
          </tbody>
        </table>
      </div>
    </template>

    <template v-else-if="name === 'review-help' && help">
      <p class="note sun">{{ t('aiReports.help.note') }}</p>
      <p v-if="!help.rows.length" class="muted">{{ t('aiReports.empty') }}</p>
      <div v-else class="table-wrap">
        <table class="table" :aria-busy="busy">
          <thead>
            <tr>
              <th>{{ t('aiReports.col.reviewer') }}</th>
              <th class="num">{{ t('aiReports.col.reviews') }}</th>
              <th class="num">{{ t('aiReports.col.hints') }}</th>
              <th class="num">{{ t('aiReports.col.shown') }}</th>
              <th class="num">{{ t('aiReports.col.agreement') }}</th>
              <th class="num">{{ t('aiReports.col.notShown') }}</th>
              <th class="num">{{ t('aiReports.col.withHint') }}</th>
              <th class="num">{{ t('aiReports.col.withoutHint') }}</th>
            </tr>
          </thead>
          <tbody>
            <tr v-for="r in help.rows" :key="r.reviewerId">
              <td>{{ r.reviewer }}</td>
              <td class="num">{{ r.reviews }}</td>
              <td class="num">{{ r.hints }}</td>
              <td class="num">{{ r.shown }}</td>
              <td class="num">{{ pct(r.matchPct) }}<span class="sub block">{{ t('aiReports.agreementSplit', { match: r.match, minor: r.minor, major: r.major }) }}</span></td>
              <td class="num">{{ r.notShown }}</td>
              <td class="num">{{ num(r.avgMinWithHint) }}</td>
              <td class="num">{{ num(r.avgMinWithoutHint) }}</td>
            </tr>
          </tbody>
        </table>
      </div>
    </template>

    <template v-else-if="name === 'cost' && cost">
      <p v-if="!cost.rows.length" class="muted">{{ t('aiReports.empty') }}</p>
      <template v-else>
        <section class="tiles">
          <div v-for="r in cost.totals" :key="`${r.purpose}-${r.currency}`" class="tile">
            <span>{{ t(`aiSettings.purpose.${r.purpose}`) }}</span>
            <b>{{ money(r.costMinor, r.currency) }}</b>
            <span class="sub">{{ t('aiReports.callsCount', { n: r.calls }) }} · {{ t('aiReports.col.errors') }}: {{ pct(r.errorPct) }}</span>
          </div>
        </section>
        <div class="table-wrap">
          <table class="table" :aria-busy="busy">
            <thead>
              <tr>
                <th>{{ t('aiReports.col.day') }}</th>
                <th>{{ t('aiReports.col.purpose') }}</th>
                <th class="num">{{ t('aiReports.col.calls') }}</th>
                <th class="num">{{ t('aiReports.col.tokens') }}</th>
                <th class="num">{{ t('aiReports.col.cost') }}</th>
                <th class="num">{{ t('aiReports.col.latency') }}</th>
                <th class="num">{{ t('aiReports.col.errors') }}</th>
              </tr>
            </thead>
            <tbody>
              <tr v-for="r in cost.rows" :key="`${r.day}-${r.purpose}-${r.currency}`">
                <td>{{ formatShortDate(r.day) }}</td>
                <td>{{ t(`aiSettings.purpose.${r.purpose}`) }}</td>
                <td class="num">{{ r.calls }}</td>
                <td class="num">{{ formatNumber(r.tokensIn) }} / {{ formatNumber(r.tokensOut) }}</td>
                <td class="num">{{ money(r.costMinor, r.currency) }}</td>
                <td class="num">{{ r.avgLatencyMs === null ? '—' : formatNumber(r.avgLatencyMs) }}</td>
                <td class="num">{{ pct(r.errorPct) }}</td>
              </tr>
            </tbody>
          </table>
        </div>
      </template>
    </template>
  </div>
</template>

<style scoped>
.chips { margin-bottom: var(--space-2); }
.sub { margin: 0; color: var(--color-ink-muted); font-size: var(--font-size-body-s); }
.block { display: block; }
.h2 { margin: var(--space-4) 0 var(--space-2); font-size: var(--font-size-body); font-weight: 900; }
.strong { font-weight: 900; }
.filters { display: flex; flex-wrap: wrap; gap: var(--space-2); align-items: end; margin: var(--space-3) 0; }
.filters label { display: grid; gap: var(--space-1); font-size: var(--font-size-body-s); font-weight: 700; }
.filters .field { width: auto; min-width: 9rem; }
.tiles { margin-bottom: var(--space-4); }
@media (max-width: 30rem) {
  .filters { flex-direction: column; align-items: stretch; }
  .filters .field { width: 100%; }
}
</style>
