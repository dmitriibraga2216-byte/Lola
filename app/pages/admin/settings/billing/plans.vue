<script setup lang="ts">
/**
 * «Змінити тариф» (docs/v2/35-billing-limits.md §5.2, форма §6.1, критерій §13 к. 7) — картки тарифів
 * за тиром, перемикач «Помісячно / Річно» з «Економія N %», поточний — «Підключено».
 *
 * Сервер рахує, клієнт показує (CLAUDE.md п. 3): перевищення за осями, скільки заблокувати чи
 * заархівувати і з якої дати діє перехід — з `GET /billing/plans` і `POST /billing/plan-change/preflight`.
 * Тариф нижче з перевищенням — «Підключити» неактивна, кораллом «Перевищено: …» і дія
 * («заблокуйте 17 співробітників»); «Перерахувати» перераховує. Тариф вище — підказка звернутися до
 * менеджера: платіжного провайдера немає, доплату і перехід вгору проводить оператор (docs/v2/44 В-21).
 */
definePageMeta({ layout: 'admin', middleware: 'admin-scope', requiredScope: 'billing.view' })
const { t } = useI18n()
const { formatShortDate, formatNumber, plural } = useFormat()
const { api } = useApi()
const { hasScope } = useAuth()

type Axis = 'users_active' | 'candidates_active' | 'storage_bytes'
interface Blocker { axis: Axis, current: number, newLimit: number, excess: number }
interface Card {
  code: string
  name: string
  titleUk: string | null
  tier: number
  direction: 'current' | 'up' | 'down'
  prices: { month: number | null, year: number | null } | null
  annualSavingPct: number | null
  limits: { users: number | null, candidates: number | null, storageBytes: number | null, aiGenerateOps: number | null, aiReviewOps: number | null, aiInterviewOps: number | null }
  blockers: Blocker[]
}
interface RequestView { id: string, toPlanCode: string, billingPeriod: 'month' | 'year', status: string, blockers: Blocker[], effectiveAt: string | null }
interface Catalog { currentPlanCode: string, billingPeriod: 'month' | 'year', currency: string, nextPeriodStart: string, plans: Card[], request: RequestView | null }

const GIB = 1024 ** 3
const catalog = ref<Catalog | null>(null)
const loading = ref(true)
const loadError = ref(false)
const period = ref<'month' | 'year'>('month')
const selected = ref<string | null>(null)
const confirmed = ref(false)
const busy = ref(false)
const formError = ref('')
const upgradeHintFor = ref<string | null>(null)
const canManage = computed(() => hasScope('billing.manage'))

async function load() {
  loading.value = true
  loadError.value = false
  try {
    catalog.value = await api<Catalog>('/billing/plans')
    period.value = catalog.value.billingPeriod
  }
  catch { loadError.value = true }
  finally { loading.value = false }
}
onMounted(load)

const fmtDate = (s: string | null) => s ? formatShortDate(`${s}T00:00:00`) : '—'
const money = (minor: number) => `${formatNumber(minor / 100, { minimumFractionDigits: 2, maximumFractionDigits: 2 })} ${catalog.value?.currency ?? ''}`
const bestSaving = computed(() => Math.max(0, ...(catalog.value?.plans ?? []).map(p => p.annualSavingPct ?? 0)))
const scheduled = computed(() => catalog.value?.request?.status === 'scheduled' ? catalog.value.request : null)
const planName = (code: string) => {
  const p = catalog.value?.plans.find(x => x.code === code)
  return p ? (p.titleUk ?? p.name) : code
}

/** Число в единице оси для людей: хранилище — гігабайти, решта — штуки. */
const axisValue = (axis: Axis, n: number) => axis === 'storage_bytes' ? t('billing.plans.gb', { n: Math.ceil(n / GIB * 100) / 100 }) : String(n)
const excessValue = (b: Blocker) => b.axis === 'storage_bytes' ? Math.ceil(b.excess / GIB * 100) / 100 : b.excess
/** «заблокуйте 17 співробітників»: N рахує сервер (`excess`), тут лише форма слова під число. */
const actionText = (b: Blocker) => {
  const n = excessValue(b)
  return t(`billing.plans.action.${b.axis}.${plural(n)}`, { n })
}
const limitText = (n: number | null, gb = false) => n == null ? t('billing.unlimited') : gb ? t('billing.plans.gb', { n: Math.round(n / GIB) }) : String(n)

function pick(card: Card) {
  formError.value = ''
  confirmed.value = false
  if (card.direction === 'up') {
    upgradeHintFor.value = card.code
    selected.value = null
    return
  }
  upgradeHintFor.value = null
  selected.value = card.code
}

async function recalc(card: Card) {
  busy.value = true
  formError.value = ''
  try {
    const r = await api<{ allowed: boolean, request: RequestView }>('/billing/plan-change/preflight', { method: 'POST', body: { planCode: card.code, billingPeriod: period.value } })
    card.blockers = r.request.blockers
    if (r.allowed) selected.value = card.code
  }
  catch (err) { formError.value = apiErrorOf(err).message }
  finally { busy.value = false }
}

async function connect(card: Card) {
  if (!confirmed.value) {
    formError.value = t('billing.plans.confirmRequired')
    return
  }
  busy.value = true
  formError.value = ''
  try {
    await api('/billing/plan-change', { method: 'POST', body: { planCode: card.code, billingPeriod: period.value, confirm: true } })
    selected.value = null
    await load()
  }
  catch (err) {
    const e = apiErrorOf(err)
    const blockers = (e.details as { blockers?: Blocker[] } | undefined)?.blockers
    if (blockers) card.blockers = blockers
    formError.value = e.message
  }
  finally { busy.value = false }
}

async function cancelScheduled() {
  if (!scheduled.value) return
  busy.value = true
  try {
    await api(`/billing/plan-change/${scheduled.value.id}`, { method: 'DELETE' })
    await load()
  }
  catch (err) { formError.value = apiErrorOf(err).message }
  finally { busy.value = false }
}
</script>

<template>
  <div>
    <PageHeader :title="t('billing.plans.title')" :crumbs="[{ label: t('admin.section.settings') }, { label: t('billing.screen.title'), to: '/admin/settings/billing' }, { label: t('billing.plans.title') }]" />

    <div v-if="loading" class="skeletons">
      <div v-for="i in 3" :key="i" class="skeleton" />
    </div>

    <template v-else-if="loadError">
      <p class="error-text" role="alert">{{ t('billing.screen.loadError') }}</p>
      <button type="button" class="btn ghost" @click="load">{{ t('billing.screen.retry') }}</button>
    </template>

    <template v-else-if="catalog">
      <p v-if="!canManage" class="note sun">{{ t('billing.plans.noAccess') }}</p>
      <div v-if="scheduled" class="note teal scheduled">
        <span>{{ t('billing.screen.scheduledNotice', { date: fmtDate(scheduled.effectiveAt), plan: planName(scheduled.toPlanCode) }) }}</span>
        <button v-if="canManage" type="button" class="btn ghost" :disabled="busy" @click="cancelScheduled">{{ t('billing.plans.cancel') }}</button>
      </div>

      <div class="period" role="radiogroup" :aria-label="t('billing.screen.billingPeriod')">
        <button type="button" role="radio" :aria-checked="period === 'month'" :class="['seg', { on: period === 'month' }]" @click="period = 'month'">{{ t('billing.plans.monthly') }}</button>
        <button type="button" role="radio" :aria-checked="period === 'year'" :class="['seg', { on: period === 'year' }]" @click="period = 'year'">
          {{ t('billing.plans.yearly') }}<span v-if="bestSaving > 0" class="saving">{{ t('billing.plans.saving', { n: bestSaving }) }}</span>
        </button>
      </div>

      <p v-if="!catalog.plans.length" class="help">{{ t('billing.plans.empty') }}</p>

      <ul class="grid">
        <li v-for="card in catalog.plans" :key="card.code" :class="['card', 'plan', { current: card.direction === 'current', chosen: selected === card.code }]" :data-plan="card.code">
          <h2 class="panel-title">{{ card.titleUk ?? card.name }}</h2>
          <p v-if="card.prices && card.prices[period] != null" class="price">{{ t('billing.plans.perMonth', { price: money(card.prices[period]!) }) }}</p>
          <dl class="kv">
            <dt>{{ t('billing.plans.limit.users') }}</dt><dd>{{ limitText(card.limits.users) }}</dd>
            <dt>{{ t('billing.plans.limit.candidates') }}</dt><dd>{{ limitText(card.limits.candidates) }}</dd>
            <dt>{{ t('billing.plans.limit.storage') }}</dt><dd>{{ limitText(card.limits.storageBytes, true) }}</dd>
            <dt>{{ t('billing.plans.limit.aiGenerate') }}</dt><dd>{{ limitText(card.limits.aiGenerateOps) }}</dd>
            <dt>{{ t('billing.plans.limit.aiReview') }}</dt><dd>{{ limitText(card.limits.aiReviewOps) }}</dd>
            <dt>{{ t('billing.plans.limit.aiInterview') }}</dt><dd>{{ limitText(card.limits.aiInterviewOps) }}</dd>
          </dl>

          <span v-if="card.direction === 'current'" class="pill teal">{{ t('billing.plans.connected') }}</span>
          <template v-else>
            <ul v-if="card.blockers.length" class="blockers" role="alert">
              <li v-for="b in card.blockers" :key="b.axis">
                {{ t('billing.plans.exceeded', { axis: t(`billing.axis.${b.axis}`), used: axisValue(b.axis, b.current), limit: axisValue(b.axis, b.newLimit) }) }}
                — {{ actionText(b) }}
              </li>
            </ul>
            <p v-if="card.blockers.length" class="help">{{ t('billing.plans.blockedHint') }}</p>
            <p v-else-if="card.direction === 'down'" class="help">{{ t('billing.plans.availableFrom', { date: fmtDate(catalog.nextPeriodStart) }) }}</p>

            <label v-if="selected === card.code && !card.blockers.length" class="confirm">
              <input v-model="confirmed" type="checkbox">
              <span>{{ t('billing.plans.confirmDown') }}</span>
            </label>

            <div v-if="canManage" class="actions">
              <button
                type="button"
                class="btn primary"
                :disabled="busy || card.blockers.length > 0 || !!scheduled"
                @click="selected === card.code ? connect(card) : pick(card)"
              >
                {{ t('billing.plans.connect') }}
              </button>
              <button v-if="card.blockers.length" type="button" class="btn ghost" :disabled="busy" @click="recalc(card)">{{ t('billing.plans.recalc') }}</button>
            </div>
            <p v-if="upgradeHintFor === card.code" class="note teal">{{ t('billing.plans.upgradeHint') }}</p>
            <p v-if="formError && (selected === card.code || card.blockers.length)" class="error-text" role="alert">{{ formError }}</p>
          </template>
        </li>
      </ul>

      <p class="back"><NuxtLink to="/admin/settings/billing">{{ t('billing.plans.back') }}</NuxtLink></p>
    </template>
  </div>
</template>

<style scoped>
.skeletons { display: grid; gap: var(--space-3); }
.skeleton { height: 120px; border-radius: var(--radius-l); background: var(--color-bg-line-soft); animation: pulse 1.4s ease-in-out infinite; }
@keyframes pulse { 0%, 100% { opacity: 0.6; } 50% { opacity: 1; } }
.scheduled { display: flex; align-items: center; justify-content: space-between; gap: var(--space-3); flex-wrap: wrap; }
.period { display: inline-flex; gap: var(--space-1); background: var(--color-bg-line-soft); border-radius: var(--radius-pill); padding: var(--space-1); margin-bottom: var(--space-4); }
.seg { border: 0; background: transparent; border-radius: var(--radius-pill); padding: var(--space-1) var(--space-3); font-weight: 800; cursor: pointer; color: var(--color-ink); }
.seg.on { background: var(--color-sun); }
.saving { margin-left: var(--space-2); font-weight: 700; color: var(--color-ink-muted); }
.grid { list-style: none; margin: 0; padding: 0; display: grid; gap: var(--space-4); grid-template-columns: repeat(auto-fill, minmax(240px, 1fr)); }
.plan { display: flex; flex-direction: column; gap: var(--space-2); }
.plan.current { outline: 2px solid var(--color-teal); }
.plan.chosen { outline: 2px solid var(--color-sun); }
.price { font-weight: 800; margin: 0; }
.kv { display: grid; grid-template-columns: auto 1fr; gap: var(--space-1) var(--space-3); margin: 0; }
.kv dt { color: var(--color-ink-muted); font-weight: 700; }
.kv dd { margin: 0; font-weight: 800; }
.pill { align-self: flex-start; display: inline-block; padding: var(--space-half) var(--space-3); border-radius: var(--radius-pill); font-size: 12px; font-weight: 800; }
.pill.teal { background: var(--color-teal); color: var(--color-ink); }
.blockers { list-style: none; margin: 0; padding: 0; display: grid; gap: var(--space-1); color: var(--color-coral-deep); font-weight: 700; }
.confirm { display: flex; gap: var(--space-2); align-items: flex-start; font-weight: 600; }
.actions { display: flex; gap: var(--space-2); flex-wrap: wrap; }
.back { margin-top: var(--space-4); }
</style>
