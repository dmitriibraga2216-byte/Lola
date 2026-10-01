<script setup lang="ts">
/**
 * Звіти вакансій — `/admin/reports/vacancies` (docs/v2/29 §9.1–§9.5): ефективність вакансії,
 * ефективність майданчиків, журнал публікацій, захист публічних сторінок, використання ШІ.
 * Область — як у реєстрі вакансій; рахує сервер, сторінка лише показує. Вивантаження — ті самі
 * рядки файлом (`report.export`, docs/22 §7). Вивантаження відгуків §9.6 — з картки вакансії.
 */
import { JOB_BOARD_PROVIDERS, VACANCY_STATES } from '#shared/enums'

definePageMeta({ layout: 'admin', middleware: 'admin-scope', requiredScope: 'vacancy.view' })

type Name = 'effectiveness' | 'boards' | 'publications' | 'protection' | 'ai'
interface Eff { vacancyId: string, title: string, state: string, location: string | null, views: number, applications: number, accepted: number, completed: number, hired: number, viewToApplyPct: number | null, applyToCompletedPct: number | null, daysToFirstHire: number | null }
interface Board { accountId: string, provider: string, ownerType: string, owner: string | null, activePublications: number, applications: number, hired: number, budget: number | null, costPerHire: number | null }
interface Pub { publicationId: string, vacancy: string, provider: string, ownerType: string, owner: string | null, initiator: string | null, state: string, publishedAt: string | null, expiresAt: string | null, attempts: number, lastError: string | null }
interface Reason { reason: string, n: number }
interface Prot { day: string, views: number, submits: number, blocked: number, pendingReview: number, spam: number, topReasons: Reason[] }
interface Ai { userId: string, user: string | null, target: string, generations: number, opsCharged: number, published: number, publishedUnedited: number, uneditedPct: number | null }
interface Option { id: string, name?: string }

const { t, te } = useI18n()
const { api } = useApi()
const { hasScope } = useAuth()
const { formatNumber, formatShortDate } = useFormat()
const route = useRoute()
const router = useRouter()

const NAMES: Name[] = ['effectiveness', 'boards', 'publications', 'protection', 'ai']
const name = computed<Name>({
  get: () => (NAMES as string[]).includes(String(route.query.r)) ? route.query.r as Name : 'effectiveness',
  set: v => router.replace({ query: { ...route.query, r: v === 'effectiveness' ? undefined : v } }),
})

const filters = reactive({ from: '', to: '', locationId: '', state: '', provider: '' })
const locations = ref<Option[]>([])
const data = ref<{ period?: { from: string, to: string }, rows: unknown[], topReasons?: Reason[] } | null>(null)
const error = ref('')
const busy = ref(false)

function query(): Record<string, string> {
  const q: Record<string, string> = {}
  for (const [k, v] of Object.entries(filters)) if (v) q[k] = v
  if (!['boards', 'publications'].includes(name.value)) delete q.provider
  return q
}

async function load() {
  busy.value = true
  error.value = ''
  try {
    data.value = await api<typeof data.value>(`/reports/vacancies/${name.value}`, { query: query() })
    if (data.value?.period && !filters.from) {
      filters.from = data.value.period.from
      filters.to = data.value.period.to
    }
  }
  catch (err) { error.value = apiErrorOf(err).message }
  finally { busy.value = false }
}
onMounted(async () => {
  await load()
  try { locations.value = await api<Option[]>('/refs/locations') }
  catch { /* немає прав на довідник — фільтр точки прихований */ }
})
watch(name, load)

function rows<T>(): T[] { return (data.value?.rows ?? []) as T[] }
const exportUrl = (format: 'xlsx' | 'csv') => `/api/v1/reports/vacancies/${name.value}?${new URLSearchParams({ ...query(), format }).toString()}`
const pct = (v: number | null) => (v === null ? '—' : `${formatNumber(v, { maximumFractionDigits: 1 })} %`)
const money = (v: number | null) => (v === null ? '—' : formatNumber(v, { maximumFractionDigits: 2 }))
const date = (v: string | null) => (v ? formatShortDate(v) : '—')
const reason = (r: string) => (te(`vacancy.spamReason.${r}`) ? t(`vacancy.spamReason.${r}`) : r)
</script>

<template>
  <div>
    <PageHeader :title="t('vacancyReports.title')" :subtitle="t('vacancyReports.hint')">
      <template #actions>
        <template v-if="hasScope('report.export')">
          <a class="btn ghost" :href="exportUrl('xlsx')">{{ t('vacancyReports.exportXlsx') }}</a>
          <a class="btn ghost" :href="exportUrl('csv')">{{ t('vacancyReports.exportCsv') }}</a>
        </template>
      </template>
    </PageHeader>

    <div class="chips" role="tablist" :aria-label="t('vacancyReports.title')">
      <button v-for="n in NAMES" :key="n" role="tab" type="button" :aria-selected="name === n" :class="['chip', { on: name === n }]" @click="name = n">{{ t(`vacancyReports.tab.${n}`) }}</button>
    </div>
    <p class="sub">{{ t(`vacancyReports.about.${name}`) }}</p>

    <form class="filters" @submit.prevent="load">
      <div class="date-label"><label for="dt-vr-from">{{ t('vacancyReports.from') }}</label> <input id="dt-vr-from" v-model="filters.from" class="field" type="date"></div>
      <div class="date-label"><label for="dt-vr-to">{{ t('vacancyReports.to') }}</label> <input id="dt-vr-to" v-model="filters.to" class="field" type="date"></div>
      <label v-if="locations.length">{{ t('vacancies.f.location') }}
        <select v-model="filters.locationId" class="field">
          <option value="">{{ t('vacancyReports.any') }}</option>
          <option v-for="l in locations" :key="l.id" :value="l.id">{{ l.name }}</option>
        </select>
      </label>
      <label>{{ t('vacancies.col.state') }}
        <select v-model="filters.state" class="field">
          <option value="">{{ t('vacancyReports.any') }}</option>
          <option v-for="s in VACANCY_STATES" :key="s" :value="s">{{ t(`vacancy.state.${s}`) }}</option>
        </select>
      </label>
      <label v-if="name === 'boards' || name === 'publications'">{{ t('vacancies.integrations.provider') }}
        <select v-model="filters.provider" class="field">
          <option value="">{{ t('vacancyReports.any') }}</option>
          <option v-for="p in JOB_BOARD_PROVIDERS" :key="p" :value="p">{{ t(`vacancy.jobBoardProvider.${p}`) }}</option>
        </select>
      </label>
      <button class="btn primary" type="submit" :disabled="busy">{{ t('vacancyReports.apply') }}</button>
    </form>

    <p v-if="error" class="note coral" role="alert">{{ error }}</p>
    <p v-else-if="data && !data.rows.length" class="muted">{{ t('vacancyReports.empty') }}</p>

    <div v-else-if="data" class="table-wrap">
      <table v-if="name === 'effectiveness'" class="table" :aria-busy="busy">
        <thead>
          <tr>
            <th>{{ t('vacancyReports.col.vacancy') }}</th>
            <th class="num">{{ t('vacancyReports.col.views') }}</th>
            <th class="num">{{ t('vacancyReports.col.applications') }}</th>
            <th class="num">{{ t('vacancyReports.col.accepted') }}</th>
            <th class="num">{{ t('vacancyReports.col.completed') }}</th>
            <th class="num">{{ t('vacancyReports.col.hired') }}</th>
            <th class="num">{{ t('vacancyReports.col.viewToApply') }}</th>
            <th class="num">{{ t('vacancyReports.col.applyToCompleted') }}</th>
            <th class="num">{{ t('vacancyReports.col.daysToHire') }}</th>
          </tr>
        </thead>
        <tbody>
          <tr v-for="r in rows<Eff>()" :key="r.vacancyId">
            <td><NuxtLink class="link" :to="`/admin/vacancies/${r.vacancyId}`">{{ r.title }}</NuxtLink><span class="sub block">{{ r.location ?? '—' }} · {{ t(`vacancy.state.${r.state}`) }}</span></td>
            <td class="num">{{ r.views }}</td>
            <td class="num">{{ r.applications }}</td>
            <td class="num">{{ r.accepted }}</td>
            <td class="num">{{ r.completed }}</td>
            <td class="num strong">{{ r.hired }}</td>
            <td class="num">{{ pct(r.viewToApplyPct) }}</td>
            <td class="num">{{ pct(r.applyToCompletedPct) }}</td>
            <td class="num">{{ r.daysToFirstHire ?? '—' }}</td>
          </tr>
        </tbody>
      </table>

      <table v-else-if="name === 'boards'" class="table" :aria-busy="busy">
        <thead>
          <tr>
            <th>{{ t('vacancies.integrations.provider') }}</th>
            <th class="num">{{ t('vacancyReports.col.active') }}</th>
            <th class="num">{{ t('vacancyReports.col.applications') }}</th>
            <th class="num">{{ t('vacancyReports.col.hired') }}</th>
            <th class="num">{{ t('vacancyReports.col.budget') }}</th>
            <th class="num">{{ t('vacancyReports.col.costPerHire') }}</th>
          </tr>
        </thead>
        <tbody>
          <tr v-for="r in rows<Board>()" :key="r.accountId">
            <td>{{ t(`vacancy.jobBoardProvider.${r.provider}`) }}<span class="sub block">{{ t(`vacancy.jobBoardOwnerType.${r.ownerType}`) }}{{ r.owner ? ` · ${r.owner}` : '' }}</span></td>
            <td class="num">{{ r.activePublications }}</td>
            <td class="num">{{ r.applications }}</td>
            <td class="num">{{ r.hired }}</td>
            <td class="num">{{ money(r.budget) }}</td>
            <td class="num strong">{{ money(r.costPerHire) }}</td>
          </tr>
        </tbody>
      </table>

      <table v-else-if="name === 'publications'" class="table" :aria-busy="busy">
        <thead>
          <tr>
            <th>{{ t('vacancyReports.col.vacancy') }}</th>
            <th>{{ t('vacancies.integrations.provider') }}</th>
            <th>{{ t('vacancyReports.col.initiator') }}</th>
            <th>{{ t('vacancies.col.state') }}</th>
            <th>{{ t('vacancyReports.col.publishedAt') }}</th>
            <th>{{ t('vacancyReports.col.expiresAt') }}</th>
            <th class="num">{{ t('vacancyReports.col.attempts') }}</th>
            <th>{{ t('vacancyReports.col.lastError') }}</th>
          </tr>
        </thead>
        <tbody>
          <tr v-for="r in rows<Pub>()" :key="r.publicationId">
            <td>{{ r.vacancy }}</td>
            <td>{{ t(`vacancy.jobBoardProvider.${r.provider}`) }}<span class="sub block">{{ t(`vacancy.jobBoardOwnerType.${r.ownerType}`) }}{{ r.owner ? ` · ${r.owner}` : '' }}</span></td>
            <td>{{ r.initiator ?? '—' }}</td>
            <td>{{ t(`vacancy.publicationState.${r.state}`) }}</td>
            <td>{{ date(r.publishedAt) }}</td>
            <td>{{ date(r.expiresAt) }}</td>
            <td class="num">{{ r.attempts }}</td>
            <td class="wrap">{{ r.lastError ?? '—' }}</td>
          </tr>
        </tbody>
      </table>

      <template v-else-if="name === 'protection'">
        <p v-if="data.topReasons?.length" class="sub">{{ t('vacancyReports.topOverall') }}: {{ data.topReasons.map(x => `${reason(x.reason)} (${x.n})`).join(', ') }}</p>
        <table class="table" :aria-busy="busy">
          <thead>
            <tr>
              <th>{{ t('vacancyReports.col.day') }}</th>
              <th class="num">{{ t('vacancyReports.col.views') }}</th>
              <th class="num">{{ t('vacancyReports.col.submits') }}</th>
              <th class="num">{{ t('vacancyReports.col.blocked') }}</th>
              <th class="num">{{ t('vacancyReports.col.pendingReview') }}</th>
              <th class="num">{{ t('vacancyReports.col.spam') }}</th>
              <th>{{ t('vacancyReports.col.topReasons') }}</th>
            </tr>
          </thead>
          <tbody>
            <tr v-for="r in rows<Prot>()" :key="r.day">
              <td>{{ formatShortDate(r.day) }}</td>
              <td class="num">{{ r.views }}</td>
              <td class="num">{{ r.submits }}</td>
              <td class="num">{{ r.blocked }}</td>
              <td class="num">{{ r.pendingReview }}</td>
              <td class="num">{{ r.spam }}</td>
              <td class="wrap">{{ r.topReasons.map(x => `${reason(x.reason)} (${x.n})`).join(', ') || '—' }}</td>
            </tr>
          </tbody>
        </table>
      </template>

      <table v-else-if="name === 'ai'" class="table" :aria-busy="busy">
        <thead>
          <tr>
            <th>{{ t('vacancyReports.col.user') }}</th>
            <th>{{ t('vacancyReports.col.block') }}</th>
            <th class="num">{{ t('vacancyReports.col.generations') }}</th>
            <th class="num">{{ t('vacancyReports.col.ops') }}</th>
            <th class="num">{{ t('vacancyReports.col.published') }}</th>
            <th class="num">{{ t('vacancyReports.col.unedited') }}</th>
          </tr>
        </thead>
        <tbody>
          <tr v-for="r in rows<Ai>()" :key="`${r.userId}-${r.target}`">
            <td>{{ r.user ?? '—' }}</td>
            <td>{{ r.target === 'criteria' ? t('vacancies.sec.criteria') : t(`vacancy.blocks.${r.target}`) }}</td>
            <td class="num">{{ r.generations }}</td>
            <td class="num">{{ r.opsCharged }}</td>
            <td class="num">{{ r.published }}</td>
            <td class="num strong">{{ pct(r.uneditedPct) }}</td>
          </tr>
        </tbody>
      </table>
    </div>
  </div>
</template>

<style scoped>
.chips { margin-bottom: var(--space-2); }
.sub { margin: 0; color: var(--color-ink-muted); font-size: var(--font-size-body-s); }
.block { display: block; }
.strong { font-weight: 900; }
.wrap { overflow-wrap: anywhere; max-width: 18rem; }
.filters { display: flex; flex-wrap: wrap; gap: var(--space-2); align-items: end; margin: var(--space-3) 0; }
.filters label, .filters .date-label { display: grid; gap: var(--space-1); font-size: var(--font-size-body-s); font-weight: 700; }
.filters .field { width: auto; min-width: 9rem; }
@media (max-width: 30rem) {
  .filters { flex-direction: column; align-items: stretch; }
  .filters .field { width: 100%; }
}
</style>
