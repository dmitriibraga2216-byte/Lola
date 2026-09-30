<script setup lang="ts">
/**
 * Звіти співбесід — `/admin/reports/interviews` (docs/v2/30 §9.1, §9.2, §9.6): «Воронка
 * співбесід», «Згоди», «Вивантаження співбесід». Скоуп `interview.view` (§2); файл — ті самі
 * рядки (`report.export`), вивантаження сесій пишеться в журнал дій.
 *
 * Звіти ні про що не вирішують (інваріант 18): воронка й згоди — лічильники без імен;
 * вивантаження — лише числа, факти для людини й збіг з рішенням людини. Розшифровок, цитат і
 * аудіо тут немає ніколи — ні на екрані, ні у файлі (§9.6).
 */
definePageMeta({ layout: 'admin', middleware: 'admin-scope', requiredScope: 'interview.view' })

type Name = 'funnel' | 'consents' | 'sessions'
interface FunnelCounts { assigned: number, agreed: number, declined: number, finished: number, needsHuman: number, avgScore: number | null, medianMinutes: number | null, agreedPct: number | null, finishedPct: number | null }
interface Funnel { rows: (FunnelCounts & { quizId: string, quiz: string, scenario: string | null })[], total: FunnelCounts }
interface Consents { rows: { vacancyId: string | null, vacancy: string | null, lang: string, decisions: number, accepted: number, declined: number, withdrawn: number, declinedPct: number | null, altHuman: number, altText: number }[], alternatives: { human_interview: number, text_form: number } }
interface SessionRow { sessionId: string, candidateId: string, candidate: string, quiz: string, scenario: string, scenarioVersion: number, date: string, state: string, durationSec: number | null, aiScore: number | null, aiConfidence: number | null, criteria: { name: string, value: number | null, scaleMax: number, humanValue: number | null, agreement: string }[], flags: string[], agreement: { match: number, minor: number, major: number, pending: number }, aiStub: boolean }
interface Sessions { rows: SessionRow[], truncated: boolean }

const { t } = useI18n()
const { api } = useApi()
const { hasScope } = useAuth()
const { formatNumber } = useFormat()
const route = useRoute()
const router = useRouter()

const NAMES: Name[] = ['funnel', 'consents', 'sessions']
const name = computed<Name>({
  get: () => (NAMES as string[]).includes(String(route.query.r)) ? route.query.r as Name : 'funnel',
  set: v => router.replace({ query: { ...route.query, r: v === 'funnel' ? undefined : v } }),
})

const filters = reactive({
  from: new Date(Date.now() - 30 * 86_400_000).toISOString().slice(0, 10),
  to: new Date().toISOString().slice(0, 10),
  vacancyId: '',
  locationId: '',
  quizId: '',
})
const vacancies = ref<{ id: string, title: string }[]>([])
const locations = ref<{ id: string, name: string }[]>([])
const quizzes = ref<{ id: string, title: string }[]>([])
const funnel = ref<Funnel | null>(null)
const consents = ref<Consents | null>(null)
const sessions = ref<Sessions | null>(null)
const error = ref('')
const busy = ref(false)

function query(): Record<string, string> {
  const q: Record<string, string> = {}
  for (const k of ['from', 'to', 'vacancyId', 'locationId', 'quizId'] as const) if (filters[k]) q[k] = filters[k]
  return q
}

async function load() {
  busy.value = true
  error.value = ''
  try {
    const r = await api<unknown>(`/reports/interviews/${name.value}`, { query: query() })
    if (name.value === 'funnel') {
      funnel.value = r as Funnel
      // Тести співбесід для фільтра — з рядків воронки без фільтра за тестом
      if (!filters.quizId) quizzes.value = funnel.value.rows.map(x => ({ id: x.quizId, title: x.quiz }))
    }
    else if (name.value === 'consents') consents.value = r as Consents
    else sessions.value = r as Sessions
  }
  catch (err) { error.value = apiErrorOf(err).message }
  finally { busy.value = false }
}
onMounted(async () => {
  // Довідники фільтрів необов'язкові: без права на вакансії звіт працює без цього фільтра
  try { vacancies.value = (await api<{ items: { id: string, title: string }[] }>('/vacancies', { query: { limit: 200 } })).items } catch { /* фільтр необов'язковий */ }
  try { locations.value = await api<{ id: string, name: string }[]>('/refs/locations') } catch { /* фільтр необов'язковий */ }
  await load()
})
watch(name, load)

const exportUrl = (format: 'xlsx' | 'csv') => `/api/v1/reports/interviews/${name.value}?${new URLSearchParams({ ...query(), format }).toString()}`
const pct = (v: number | null) => (v === null ? '—' : `${formatNumber(v, { maximumFractionDigits: 1 })} %`)
const num = (v: number | null, digits = 1) => (v === null ? '—' : formatNumber(v, { maximumFractionDigits: digits }))
const minutes = (sec: number | null) => (sec === null ? '—' : formatNumber(sec / 60, { maximumFractionDigits: 1 }))
const langLabel = (l: string) => t(`interviewReports.lang.${l}`, l)
</script>

<template>
  <div>
    <PageHeader :title="t('interviewReports.title')" :subtitle="t('interviewReports.hint')">
      <template #actions>
        <template v-if="hasScope('report.export')">
          <a class="btn ghost" :href="exportUrl('xlsx')" data-testid="interview-report-xlsx">{{ t('aiReports.exportXlsx') }}</a>
          <a class="btn ghost" :href="exportUrl('csv')">{{ t('aiReports.exportCsv') }}</a>
        </template>
      </template>
    </PageHeader>

    <div class="chips" role="tablist" :aria-label="t('interviewReports.title')">
      <button v-for="n in NAMES" :key="n" role="tab" type="button" :aria-selected="name === n" :class="['chip', { on: name === n }]" @click="name = n">{{ t(`interviewReports.tab.${n}`) }}</button>
    </div>
    <p class="sub">{{ t(`interviewReports.about.${name}`) }}</p>

    <form class="filters" @submit.prevent="load">
      <div class="date-label"><label for="ir-from">{{ t('aiReports.from') }}</label> <input id="ir-from" v-model="filters.from" class="field" type="date"></div>
      <div class="date-label"><label for="ir-to">{{ t('aiReports.to') }}</label> <input id="ir-to" v-model="filters.to" class="field" type="date"></div>
      <label v-if="vacancies.length">{{ t('interviewReports.vacancy') }}
        <select v-model="filters.vacancyId" class="field">
          <option value="">{{ t('interviewReports.any') }}</option>
          <option v-for="v in vacancies" :key="v.id" :value="v.id">{{ v.title }}</option>
        </select>
      </label>
      <label v-if="locations.length">{{ t('interviewReports.location') }}
        <select v-model="filters.locationId" class="field">
          <option value="">{{ t('interviewReports.any') }}</option>
          <option v-for="l in locations" :key="l.id" :value="l.id">{{ l.name }}</option>
        </select>
      </label>
      <label v-if="quizzes.length">{{ t('interviewReports.scenario') }}
        <select v-model="filters.quizId" class="field">
          <option value="">{{ t('interviewReports.any') }}</option>
          <option v-for="q in quizzes" :key="q.id" :value="q.id">{{ q.title }}</option>
        </select>
      </label>
      <button class="btn primary" type="submit" :disabled="busy">{{ t('aiReports.apply') }}</button>
    </form>

    <p v-if="error" class="note coral" role="alert">{{ error }}</p>

    <template v-if="name === 'funnel' && funnel">
      <p v-if="!funnel.rows.length" class="muted">{{ t('aiReports.empty') }}</p>
      <template v-else>
        <div class="tiles" data-testid="interview-funnel-total">
          <div class="tile"><b>{{ funnel.total.assigned }}</b><span>{{ t('interviewReports.col.assigned') }}</span></div>
          <div class="tile"><b>{{ funnel.total.agreed }}</b><span>{{ t('interviewReports.col.agreed') }} · {{ pct(funnel.total.agreedPct) }}</span></div>
          <div class="tile"><b>{{ funnel.total.declined }}</b><span>{{ t('interviewReports.col.declined') }}</span></div>
          <div class="tile teal"><b>{{ funnel.total.finished }}</b><span>{{ t('interviewReports.col.finished') }} · {{ pct(funnel.total.finishedPct) }}</span></div>
          <div class="tile"><b>{{ funnel.total.needsHuman }}</b><span>{{ t('interviewReports.col.needsHuman') }}</span></div>
        </div>
        <p class="note sun">{{ t('interviewReports.funnelNote') }}</p>
        <div class="table-wrap">
          <table class="table" :aria-busy="busy">
            <thead>
              <tr>
                <th>{{ t('interviewReports.col.scenario') }}</th>
                <th class="num">{{ t('interviewReports.col.assigned') }}</th>
                <th class="num">{{ t('interviewReports.col.agreed') }}</th>
                <th class="num">{{ t('interviewReports.col.declined') }}</th>
                <th class="num">{{ t('interviewReports.col.finished') }}</th>
                <th class="num">{{ t('interviewReports.col.needsHuman') }}</th>
                <th class="num">{{ t('interviewReports.col.avgScore') }}</th>
                <th class="num">{{ t('interviewReports.col.median') }}</th>
              </tr>
            </thead>
            <tbody>
              <tr v-for="r in funnel.rows" :key="r.quizId">
                <td>{{ r.quiz }}<span v-if="r.scenario" class="sub block">{{ r.scenario }}</span></td>
                <td class="num">{{ r.assigned }}</td>
                <td class="num">{{ r.agreed }}<span class="sub block">{{ pct(r.agreedPct) }}</span></td>
                <td class="num">{{ r.declined }}</td>
                <td class="num">{{ r.finished }}<span class="sub block">{{ pct(r.finishedPct) }}</span></td>
                <td class="num">{{ r.needsHuman }}</td>
                <td class="num">{{ num(r.avgScore) }}</td>
                <td class="num">{{ num(r.medianMinutes) }}</td>
              </tr>
            </tbody>
          </table>
        </div>
      </template>
    </template>

    <template v-else-if="name === 'consents' && consents">
      <p v-if="!consents.rows.length" class="muted">{{ t('aiReports.empty') }}</p>
      <template v-else>
        <div class="tiles">
          <div class="tile"><b>{{ consents.alternatives.human_interview }}</b><span>{{ t('interviewReports.alt.human_interview') }}</span></div>
          <div class="tile"><b>{{ consents.alternatives.text_form }}</b><span>{{ t('interviewReports.alt.text_form') }}</span></div>
        </div>
        <p class="note sun">{{ t('interviewReports.consentsNote') }}</p>
        <div class="table-wrap">
          <table class="table" :aria-busy="busy">
            <thead>
              <tr>
                <th>{{ t('interviewReports.col.vacancy') }}</th>
                <th>{{ t('interviewReports.col.lang') }}</th>
                <th class="num">{{ t('interviewReports.col.decisions') }}</th>
                <th class="num">{{ t('interviewReports.col.accepted') }}</th>
                <th class="num">{{ t('interviewReports.col.declined') }}</th>
                <th class="num">{{ t('interviewReports.col.withdrawn') }}</th>
                <th class="num">{{ t('interviewReports.alt.human_interview') }}</th>
                <th class="num">{{ t('interviewReports.alt.text_form') }}</th>
              </tr>
            </thead>
            <tbody>
              <tr v-for="(r, i) in consents.rows" :key="i">
                <td>{{ r.vacancy ?? t('interviewReports.noVacancy') }}</td>
                <td>{{ langLabel(r.lang) }}</td>
                <td class="num">{{ r.decisions }}</td>
                <td class="num">{{ r.accepted }}</td>
                <td class="num strong">{{ r.declined }}<span class="sub block">{{ pct(r.declinedPct) }}</span></td>
                <td class="num">{{ r.withdrawn }}</td>
                <td class="num">{{ r.altHuman }}</td>
                <td class="num">{{ r.altText }}</td>
              </tr>
            </tbody>
          </table>
        </div>
      </template>
    </template>

    <template v-else-if="name === 'sessions' && sessions">
      <p class="note sun">{{ t('interviewReports.sessionsNote') }}</p>
      <p v-if="sessions.truncated" class="note coral">{{ t('interviewReports.truncated') }}</p>
      <p v-if="!sessions.rows.length" class="muted">{{ t('aiReports.empty') }}</p>
      <ul v-else class="cards" data-testid="interview-sessions">
        <li v-for="r in sessions.rows" :key="r.sessionId" class="card">
          <div class="head">
            <NuxtLink :to="`/admin/candidates/${r.candidateId}?tab=interview`" class="strong">{{ r.candidate }}</NuxtLink>
            <span class="sub">{{ r.date }} · {{ r.quiz }} · {{ r.scenario }} (v{{ r.scenarioVersion }})</span>
          </div>
          <dl class="facts">
            <div><dt>{{ t('interviewReports.col.state') }}</dt><dd>{{ t(`interview.card.state.${r.state}`, r.state) }}</dd></div>
            <div><dt>{{ t('interviewReports.col.duration') }}</dt><dd>{{ minutes(r.durationSec) }}</dd></div>
            <div><dt>{{ t('interviewReports.col.aiScore') }}</dt><dd>{{ num(r.aiScore) }}<span v-if="r.aiStub" class="sub block">{{ t('interviewReports.stub') }}</span></dd></div>
            <div><dt>{{ t('interviewReports.col.confidence') }}</dt><dd>{{ num(r.aiConfidence, 2) }}</dd></div>
            <div><dt>{{ t('interviewReports.col.agreement') }}</dt><dd>{{ t('aiReports.agreementSplit', { match: r.agreement.match, minor: r.agreement.minor, major: r.agreement.major }) }}</dd></div>
          </dl>
          <p v-if="r.criteria.length" class="sub">
            <span v-for="c in r.criteria" :key="c.name" class="crit">{{ c.name }}: {{ num(c.value) }}/{{ c.scaleMax }}<template v-if="c.humanValue !== null"> · {{ t('interviewReports.human', { v: num(c.humanValue) }) }}</template></span>
          </p>
          <p v-if="r.flags.length" class="flags">
            <span class="sub">{{ t('interview.card.flagsTitle') }}:</span>
            <span v-for="f in r.flags" :key="f" class="chip">{{ t(`interview.card.flag.${f}`, f) }}</span>
          </p>
        </li>
      </ul>
    </template>
  </div>
</template>

<style scoped>
.chips { margin-bottom: var(--space-2); }
.sub { margin: 0; color: var(--color-ink-muted); font-size: var(--font-size-body-s); }
.block { display: block; }
.strong { font-weight: 900; }
.filters { display: flex; flex-wrap: wrap; gap: var(--space-2); align-items: end; margin: var(--space-3) 0; }
.filters label, .filters .date-label { display: grid; gap: var(--space-1); font-size: var(--font-size-body-s); font-weight: 700; }
.filters .field { width: auto; min-width: 9rem; max-width: 100%; }
.tiles { margin-bottom: var(--space-3); }
.cards { list-style: none; margin: 0; padding: 0; display: grid; gap: var(--space-2); }
.card { padding: var(--space-3); overflow-wrap: anywhere; }
.head { display: grid; gap: var(--space-1); margin-bottom: var(--space-2); }
.facts { display: flex; flex-wrap: wrap; gap: var(--space-2) var(--space-4); margin: 0 0 var(--space-2); }
.facts dt { font-size: var(--font-size-body-s); color: var(--color-ink-muted); }
.facts dd { margin: 0; font-weight: 700; }
.crit { display: inline-block; margin-right: var(--space-3); }
.flags { display: flex; flex-wrap: wrap; gap: var(--space-1); align-items: center; margin: 0; }
@media (max-width: 30rem) {
  .filters { flex-direction: column; align-items: stretch; }
  .filters .field { width: 100%; }
}
</style>
