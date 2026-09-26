<script setup lang="ts">
/**
 * Карточка компанії (docs/24 §4.2, §4.4–4.5, §4.8, docs/25 §7 п. 4, 6–7; ops-console-2):
 * «Огляд» з PR №1 плюс перенесені дії старої панелі `/ops` — ліміти, тариф і оплата, користувачі
 * та скидання їм 2FA, власний домен і SMTP-TLS, етапи життєвого циклу, зупинка/відновлення,
 * остаточне видалення, вхід «від імені». Кожна вкладка ховається, якщо в ролі немає права
 * (`platformCan`) — сервер усе одно перевіряє права сам (CLAUDE.md п. 3).
 */
import { STAGE_CAPABILITIES } from '#shared/enums'
import type { StageCapability } from '#shared/enums'

definePageMeta({ layout: 'ops', middleware: 'ops-auth' })
const { t } = useI18n()
const { formatShortDate } = useFormat()
const { ops, can } = useOps()
const route = useRoute()
const tenantId = route.params.id as string

// ── Огляд (PR №1) ────────────────────────────────────────────────────
interface Overview {
  tenant: { id: string, slug: string, name: string, status: string, plan: string, trialEndsAt: string | null, createdAt: string, archivedAt: string | null, customDomain: string | null }
  stats: { activeUsers: number, totalUsers: number, wau: number, completed30d: number }
  flags: string[]
  subscription: { status: string, paidUntil: string | null, graceUntil: string | null, aiUntil: string | null, billingPeriod: string } | null
  consumption: { axis: string, used: number, limit: number | null, pct: number | null, level: 'ok' | 'warn' | 'exceeded', source: string }[]
  recent: { id: string, action: string, adminEmail: string, createdAt: string }[]
}
const data = ref<Overview | null>(null)
const error = ref('')
const notice = ref('')

async function loadOverview() {
  error.value = ''
  try { data.value = await ops<Overview>(`/tenants/${tenantId}/overview`) }
  catch (err) { error.value = apiErrorOf(err).message }
}
onMounted(loadOverview)

const fmt = (d: string | null) => d ? formatShortDate(new Date(d)) : '—'
const GIB = 1024 ** 3
const amount = (axis: string, v: number | null) => v == null ? t('opsConsole.overview.unlimited') : axis === 'storage_bytes' ? `${(v / GIB).toFixed(1)} ${t('ops.gb')}` : String(v)
const axisName = (axis: string) => t(`billing.axis.${axis}`)
const bar = (pct: number | null) => `${Math.min(100, Math.round((pct ?? 0) * 100))}%`

// ── Вкладки ──────────────────────────────────────────────────────────
type TabKey = 'overview' | 'limits' | 'billing' | 'users' | 'domain' | 'lifecycle' | 'actions'
const TABS: { key: TabKey, show: () => boolean }[] = [
  { key: 'overview', show: () => true },
  { key: 'limits', show: () => can('billing.read') },
  { key: 'billing', show: () => can('billing.read') },
  { key: 'users', show: () => can('tenant.users.read') },
  { key: 'domain', show: () => can('tenant.update') },
  { key: 'lifecycle', show: () => can('tenant.update') },
  { key: 'actions', show: () => can('tenant.suspend') || can('tenant.purge') || can('tenant.impersonate') },
]
const visibleTabs = computed(() => TABS.filter(tb => tb.show()))
const tab = ref<TabKey>('overview')
const loadedTabs = new Set<TabKey>(['overview'])
function selectTab(k: TabKey) {
  tab.value = k
  if (loadedTabs.has(k)) return
  loadedTabs.add(k)
  if (k === 'limits') loadLimits()
  else if (k === 'billing') loadBilling()
  else if (k === 'users') loadUsers()
  else if (k === 'domain') loadDomain()
  else if (k === 'lifecycle') loadStages()
}

// ── Ліміти (docs/24 §4.4) ────────────────────────────────────────────
interface Limits {
  plan: { code: string, users: number | null, storageGb: number | null, smsPerMonth: number | null, candidates: number | null, aiGenerateOps: number | null, aiReviewOps: number | null, aiInterviewOps: number | null, exportRows: number | null }
  overrides: { users: number | null, storageGb: number | null, smsPerMonth: number | null, apiPerMinute: number | null, webhooks: number | null, activeJobs: number | null, candidates: number | null, aiGenerateOps: number | null, aiReviewOps: number | null, aiInterviewOps: number | null, exportRows: number | null }
  subscription: { billingPeriod: 'month' | 'year', status: string, paidUntil: string | null, graceUntil: string | null, aiUntil: string | null, autorenew: boolean, currency: string, aiStatus: string }
}
type LimitKey = keyof Limits['overrides']
type PlanLimitKey = keyof Limits['plan']
const LIMIT_KEYS: LimitKey[] = ['users', 'candidates', 'storageGb', 'smsPerMonth', 'aiGenerateOps', 'aiReviewOps', 'aiInterviewOps', 'exportRows', 'apiPerMinute', 'webhooks', 'activeJobs']
const PLAN_LIMIT_KEYS = new Set<LimitKey>(['users', 'candidates', 'storageGb', 'smsPerMonth', 'aiGenerateOps', 'aiReviewOps', 'aiInterviewOps', 'exportRows'])
const limits = ref<Limits | null>(null)
const limitsForm = reactive<Record<LimitKey, string>>({ users: '', storageGb: '', smsPerMonth: '', apiPerMinute: '', webhooks: '', activeJobs: '', candidates: '', aiGenerateOps: '', aiReviewOps: '', aiInterviewOps: '', exportRows: '' })
const busy = ref(false)
const plans = ref<{ code: string, name: string }[]>([])
onMounted(async () => { try { plans.value = await ops('/plans') } catch { /* назва тарифу — кодом, якщо список недоступний */ } })
const planName = (code: string) => plans.value.find(p => p.code === code)?.name ?? code

async function loadLimits() {
  error.value = ''
  try {
    limits.value = await ops<Limits>(`/tenants/${tenantId}/limits`)
    for (const k of LIMIT_KEYS) limitsForm[k] = limits.value.overrides[k] == null ? '' : String(limits.value.overrides[k])
  }
  catch (err) { error.value = apiErrorOf(err).message }
}
async function saveLimits() {
  if (busy.value) return
  error.value = ''
  busy.value = true
  const body = Object.fromEntries(LIMIT_KEYS.map(k => [k, limitsForm[k].trim() === '' ? null : Number(limitsForm[k])]))
  try {
    await ops(`/tenants/${tenantId}/limits`, { method: 'PUT', body })
    notice.value = t('opsConsole.limits.saved')
    await loadLimits()
  }
  catch (err) { error.value = apiErrorOf(err).message }
  finally { busy.value = false }
}

// ── Тариф і оплата (docs/v2/35 §5.6, §7.10) ─────────────────────────
interface Payment {
  id: string, kind: 'subscription' | 'addon' | 'adjustment', planCode: string | null, addonCode: string | null
  billingPeriod: string | null, periodFrom: string | null, periodTo: string | null, amountMinor: number | string, currency: string
  status: string, method: string | null, invoiceNumber: string | null, comment: string | null, createdAt: string
}
const ADDON_CODES = ['storage_pack', 'ai_ops_pack', 'sms_pack', 'candidates_pack', 'ai_term']
const payments = ref<Payment[]>([])
const extendForm = reactive({ paidUntil: '', aiUntil: '', comment: '' })
const paymentForm = reactive({
  kind: 'subscription' as 'subscription' | 'addon' | 'adjustment', billingPeriod: 'month' as 'month' | 'year',
  addonCode: '', qty: '1', amount: '', currency: 'EUR', method: 'bank_transfer' as 'bank_transfer' | 'card' | 'manual', invoiceNumber: '', comment: '',
})
const planChange = reactive({ toPlanCode: '', billingPeriod: 'month' as 'month' | 'year', comment: '' })

async function loadBilling() {
  error.value = ''
  try {
    [limits.value, payments.value] = await Promise.all([ops<Limits>(`/tenants/${tenantId}/limits`), ops<Payment[]>(`/tenants/${tenantId}/payments`)])
    Object.assign(paymentForm, { kind: 'subscription', billingPeriod: limits.value.subscription.billingPeriod, addonCode: '', qty: '1', amount: '', currency: limits.value.subscription.currency, method: 'bank_transfer', invoiceNumber: '', comment: '' })
    Object.assign(extendForm, { paidUntil: limits.value.subscription.paidUntil ?? '', aiUntil: limits.value.subscription.aiUntil ?? '', comment: '' })
    planChange.toPlanCode = ''
    planChange.comment = ''
  }
  catch (err) { error.value = apiErrorOf(err).message }
}
const extendReady = computed(() => extendForm.comment.trim().length >= 10)
async function submitExtend() {
  if (!extendReady.value || busy.value) return
  error.value = ''
  busy.value = true
  try {
    await ops(`/tenants/${tenantId}/extend`, { method: 'POST', body: { paidUntil: extendForm.paidUntil || null, aiUntil: extendForm.aiUntil || null, comment: extendForm.comment.trim() } })
    notice.value = t('opsConsole.billing.extended')
    await loadBilling()
    await loadOverview()
  }
  catch (err) { error.value = apiErrorOf(err).message }
  finally { busy.value = false }
}
const paymentReady = computed(() => paymentForm.comment.trim().length >= 10 && paymentForm.amount !== '' && Number(paymentForm.amount) >= 0 && (paymentForm.kind !== 'addon' || paymentForm.addonCode !== ''))
async function submitPayment() {
  if (!paymentReady.value || busy.value) return
  error.value = ''
  busy.value = true
  try {
    await ops(`/tenants/${tenantId}/payments`, {
      method: 'POST',
      body: {
        kind: paymentForm.kind,
        billingPeriod: paymentForm.kind === 'subscription' ? paymentForm.billingPeriod : undefined,
        addonCode: paymentForm.kind === 'addon' ? paymentForm.addonCode : undefined,
        qty: paymentForm.kind === 'addon' ? Number(paymentForm.qty) : undefined,
        amountMinor: Math.round(Number(paymentForm.amount) * 100),
        currency: paymentForm.currency,
        method: paymentForm.method,
        invoiceNumber: paymentForm.invoiceNumber.trim() || undefined,
        comment: paymentForm.comment.trim(),
      },
    })
    notice.value = t('opsConsole.billing.paymentRecorded')
    await loadBilling()
    await loadOverview()
  }
  catch (err) { error.value = apiErrorOf(err).message }
  finally { busy.value = false }
}
const planChangeReady = computed(() => planChange.toPlanCode !== '' && planChange.toPlanCode !== data.value?.tenant.plan && planChange.comment.trim().length >= 10)
async function submitPlanChange() {
  if (!planChangeReady.value || busy.value) return
  error.value = ''
  busy.value = true
  try {
    await ops(`/tenants/${tenantId}/plan-change`, { method: 'POST', body: { toPlanCode: planChange.toPlanCode, billingPeriod: planChange.billingPeriod, comment: planChange.comment.trim() } })
    notice.value = t('opsConsole.billing.planChanged')
    planChange.toPlanCode = ''
    planChange.comment = ''
    await loadBilling()
    await loadOverview()
  }
  catch (err) { error.value = apiErrorOf(err).message }
  finally { busy.value = false }
}

// ── Користувачі та скидання 2FA / вхід «від імені» (docs/24 §3.4, §4.5) ─
interface TenantUser { id: string, fullName: string, phone: string | null, status: string, twoFactor?: boolean }
const users = ref<TenantUser[]>([])
const resetFor = ref<TenantUser | null>(null)
const resetReason = ref('')
const impFor = ref<TenantUser | null>(null)
const impReason = ref('')

async function loadUsers() {
  error.value = ''
  try { users.value = await ops<TenantUser[]>(`/tenants/${tenantId}/users`) }
  catch (err) { error.value = apiErrorOf(err).message }
}
async function resetTwoFactor() {
  if (!resetFor.value || resetReason.value.trim().length < 10 || busy.value) return
  error.value = ''
  busy.value = true
  try {
    await ops(`/tenants/${tenantId}/users/${resetFor.value.id}/two-factor-reset`, { method: 'POST', body: { reason: resetReason.value.trim() } })
    notice.value = t('opsConsole.tenantUsers.resetDone', { name: resetFor.value.fullName })
    resetFor.value = null
  }
  catch (err) { error.value = apiErrorOf(err).message }
  finally { busy.value = false }
}
async function doImpersonate() {
  if (!impFor.value || impReason.value.trim().length < 10 || busy.value) return
  error.value = ''
  busy.value = true
  try {
    const r = await ops<{ handoffUrl: string | null }>(`/tenants/${tenantId}/impersonate`, { method: 'POST', body: { userId: impFor.value.id, reason: impReason.value.trim() } })
    window.open(r.handoffUrl ?? '/', '_blank')
    impFor.value = null
  }
  catch (err) { error.value = apiErrorOf(err).message }
  finally { busy.value = false }
}

// ── Домен і SMTP-TLS (docs/25 §16.1, докс/33 D-059, docs/09 §9.7.1 п. 3) ─
const domainValue = ref('')
const ignoreTlsErrors = ref(false)
async function loadDomain() {
  error.value = ''
  domainValue.value = data.value?.tenant.customDomain ?? ''
  try { ignoreTlsErrors.value = (await ops<{ ignoreTlsErrors: boolean }>(`/tenants/${tenantId}/smtp-tls`)).ignoreTlsErrors }
  catch (err) { error.value = apiErrorOf(err).message }
}
async function saveDomain() {
  if (busy.value) return
  error.value = ''
  busy.value = true
  try {
    await ops(`/tenants/${tenantId}`, { method: 'PATCH', body: { customDomain: domainValue.value.trim() || null } })
    notice.value = t('opsConsole.domainTab.saved')
    await loadOverview()
  }
  catch (err) { error.value = apiErrorOf(err).message }
  finally { busy.value = false }
}
async function saveSmtp() {
  if (busy.value) return
  error.value = ''
  busy.value = true
  try {
    await ops(`/tenants/${tenantId}/smtp-tls`, { method: 'PUT', body: { ignoreTlsErrors: ignoreTlsErrors.value } })
    notice.value = t('opsConsole.domainTab.smtpSaved')
  }
  catch (err) { error.value = apiErrorOf(err).message }
  finally { busy.value = false }
}

// ── Етапи життєвого циклу (docs/v2/33 §2, §5.2; можливості — лише оператор) ─
interface StageRow {
  id: string, code: string, nameUk: string, nameEn: string | null, icon: string | null, color: string, sort: number
  isEnabled: boolean, expectedDays: number | null, capabilities: Partial<Record<StageCapability, boolean>>, coursesCount: number, peopleCount: number
}
const stages = ref<StageRow[]>([])
const savingStage = ref('')
async function loadStages() {
  error.value = ''
  try { stages.value = await ops<StageRow[]>(`/tenants/${tenantId}/lifecycle-stages`) }
  catch (err) { error.value = apiErrorOf(err).message }
}
async function toggleCapability(s: StageRow, cap: StageCapability) {
  if (!can('tenant.update') || savingStage.value) return
  error.value = ''
  savingStage.value = s.id
  const capabilities = { ...s.capabilities, [cap]: !s.capabilities[cap] }
  try {
    const updated = await ops<StageRow>(`/tenants/${tenantId}/lifecycle-stages/${s.id}`, { method: 'PATCH', body: { capabilities } })
    const i = stages.value.findIndex(x => x.id === s.id)
    if (i >= 0) stages.value[i] = updated
  }
  catch (err) { error.value = apiErrorOf(err).message }
  finally { savingStage.value = '' }
}

// ── Дії з простором: зупинка, відновлення, остаточне видалення (docs/24 §7 п. 5, §8) ─
const PURGE_DAYS = 30
const actionKind = ref<'suspend' | 'resume' | 'purge' | 'cancelPurge' | null>(null)
const suspendReason = ref('')
const confirmSlug = ref('')
function openAction(kind: NonNullable<typeof actionKind.value>) { actionKind.value = kind; suspendReason.value = ''; confirmSlug.value = '' }
const actionReady = computed(() => actionKind.value !== 'purge' || confirmSlug.value.trim() === data.value?.tenant.slug)
async function runAction() {
  if (!actionKind.value || !actionReady.value || busy.value) return
  error.value = ''
  busy.value = true
  try {
    if (actionKind.value === 'suspend') await ops(`/tenants/${tenantId}/suspend`, { method: 'POST', body: { reason: suspendReason.value || undefined } })
    if (actionKind.value === 'resume') await ops(`/tenants/${tenantId}/resume`, { method: 'POST' })
    if (actionKind.value === 'purge') await ops(`/tenants/${tenantId}/purge`, { method: 'POST', body: { confirmSlug: confirmSlug.value.trim() } })
    if (actionKind.value === 'cancelPurge') await ops(`/tenants/${tenantId}/purge`, { method: 'DELETE' })
    notice.value = t(`opsConsole.actionsTab.done.${actionKind.value}`)
    actionKind.value = null
    await loadOverview()
  }
  catch (err) { error.value = apiErrorOf(err).message }
  finally { busy.value = false }
}
const purgeAt = computed(() => data.value?.tenant.archivedAt ? fmt(new Date(new Date(data.value.tenant.archivedAt).getTime() + PURGE_DAYS * 86_400_000).toISOString()) : '—')
</script>

<template>
  <section>
    <NuxtLink to="/ops/companies" class="link back">{{ t('opsConsole.overview.back') }}</NuxtLink>
    <p v-if="error" class="error-text" role="alert">{{ error }}</p>
    <p v-if="notice" class="note teal" role="status">{{ notice }} <button type="button" class="link" @click="notice = ''">×</button></p>
    <template v-if="data">
      <h1 class="title">{{ data.tenant.name }} <span class="muted slug">{{ data.tenant.slug }}</span></h1>
      <nav class="chips tabs" :aria-label="t('opsConsole.overview.tabs')">
        <button v-for="tb in visibleTabs" :key="tb.key" type="button" class="chip" :class="{ on: tab === tb.key }" :aria-current="tab === tb.key ? 'page' : undefined" @click="selectTab(tb.key)">{{ t(`opsConsole.tabs.${tb.key}`) }}</button>
      </nav>

      <section v-if="tab === 'overview'">
        <div class="grid">
          <div class="card">
            <h2>{{ t('opsConsole.overview.state') }}</h2>
            <p><span class="badge" :class="data.tenant.status === 'active' ? 'teal' : 'muted'">{{ t(`opsConsole.status.${data.tenant.status}`) }}</span></p>
            <p v-if="data.flags.length" class="chips">
              <span v-for="f in data.flags" :key="f" class="badge" :class="f === 'limit_near' ? 'sun' : 'coral'">{{ t(`opsConsole.flags.${f}`) }}</span>
            </p>
            <dl>
              <dt>{{ t('opsConsole.companies.plan') }}</dt><dd>{{ planName(data.tenant.plan) }}</dd>
              <dt>{{ t('opsConsole.overview.trialEnds') }}</dt><dd>{{ fmt(data.tenant.trialEndsAt) }}</dd>
              <template v-if="data.subscription">
                <dt>{{ t('opsConsole.overview.paidUntil') }}</dt><dd>{{ fmt(data.subscription.paidUntil) }}</dd>
                <dt>{{ t('opsConsole.overview.aiUntil') }}</dt><dd>{{ fmt(data.subscription.aiUntil) }}</dd>
              </template>
              <dt>{{ t('opsConsole.companies.created') }}</dt><dd>{{ fmt(data.tenant.createdAt) }}</dd>
              <template v-if="data.tenant.customDomain">
                <dt>{{ t('opsConsole.domainTab.title') }}</dt><dd>{{ data.tenant.customDomain }}</dd>
              </template>
            </dl>
          </div>
          <div class="card">
            <h2>{{ t('opsConsole.overview.people') }}</h2>
            <dl>
              <dt>{{ t('opsConsole.overview.activeUsers') }}</dt><dd>{{ data.stats.activeUsers }}</dd>
              <dt>{{ t('opsConsole.overview.totalUsers') }}</dt><dd>{{ data.stats.totalUsers }}</dd>
              <dt>{{ t('opsConsole.overview.wau') }}</dt><dd>{{ data.stats.wau }}</dd>
              <dt>{{ t('opsConsole.overview.completed30d') }}</dt><dd>{{ data.stats.completed30d }}</dd>
            </dl>
          </div>
        </div>
        <div class="card">
          <h2>{{ t('opsConsole.overview.consumption') }}</h2>
          <ul class="axes">
            <li v-for="c in data.consumption" :key="c.axis">
              <div class="axis-head"><span>{{ axisName(c.axis) }}</span><span class="muted">{{ amount(c.axis, c.used) }} / {{ amount(c.axis, c.limit) }}</span></div>
              <div v-if="c.limit != null" class="meter" role="meter" :aria-valuenow="Math.round((c.pct ?? 0) * 100)" aria-valuemin="0" aria-valuemax="100" :aria-label="axisName(c.axis)">
                <span :class="c.level" :style="{ width: bar(c.pct) }" />
              </div>
            </li>
          </ul>
        </div>
        <div class="card">
          <h2>{{ t('opsConsole.overview.recent') }}</h2>
          <ul v-if="data.recent.length" class="recent">
            <li v-for="r in data.recent" :key="r.id"><b>{{ r.action }}</b> <span class="muted">{{ r.adminEmail }} · {{ fmt(r.createdAt) }}</span></li>
          </ul>
          <p v-else class="muted">{{ t('opsConsole.overview.noRecent') }}</p>
        </div>
      </section>

      <section v-else-if="tab === 'limits' && limits" class="card">
        <h2>{{ t('opsConsole.limits.title') }}</h2>
        <p class="help">{{ t('opsConsole.limits.hint', { plan: planName(limits.plan.code) }) }}</p>
        <div class="grid two">
          <label v-for="k in LIMIT_KEYS" :key="k" class="field-wrap">
            <span class="label">{{ t(`opsConsole.limits.${k}`) }}<em v-if="PLAN_LIMIT_KEYS.has(k)" class="muted"> · {{ t('opsConsole.limits.plan') }}: {{ limits.plan[k as PlanLimitKey] ?? '∞' }}</em></span>
            <input v-model="limitsForm[k]" class="field" type="number" min="0" inputmode="numeric" :disabled="!can('billing.limits')" :placeholder="t('opsConsole.limits.fromPlan')">
          </label>
        </div>
        <div class="chips"><button v-if="can('billing.limits')" type="button" class="btn primary" :disabled="busy" @click="saveLimits">{{ t('common.save') }}</button></div>
      </section>

      <section v-else-if="tab === 'billing' && limits" class="stack">
        <div class="card">
          <h2>{{ t('opsConsole.tabs.billing') }}</h2>
          <dl>
            <dt>{{ t('opsConsole.billing.status') }}</dt><dd><span class="badge" :class="limits.subscription.status">{{ t(`opsConsole.billing.state.${limits.subscription.status}`) }}</span></dd>
            <dt>{{ t('opsConsole.billing.paidUntil') }}</dt><dd>{{ fmt(limits.subscription.paidUntil) }}</dd>
            <dt>{{ t('opsConsole.billing.aiUntil') }}</dt><dd>{{ fmt(limits.subscription.aiUntil) }} <span class="muted">({{ t(`opsConsole.billing.aiState.${limits.subscription.aiStatus}`) }})</span></dd>
            <dt>{{ t('opsConsole.billing.period') }}</dt><dd>{{ t(`opsConsole.billing.periodOf.${limits.subscription.billingPeriod}`) }}</dd>
          </dl>
        </div>

        <form v-if="can('billing.plan_change')" class="card" data-testid="ops-billing-planchange" @submit.prevent="submitPlanChange">
          <h2>{{ t('opsConsole.billing.changeTitle') }}</h2>
          <div class="row">
            <label class="field-wrap"><span class="label">{{ t('opsConsole.companies.plan') }}</span>
              <select v-model="planChange.toPlanCode" class="field"><option value="" disabled>{{ t('opsConsole.companies.anyPlan') }}</option><option v-for="p in plans" :key="p.code" :value="p.code">{{ p.name }}</option></select>
            </label>
            <label class="field-wrap"><span class="label">{{ t('opsConsole.billing.period') }}</span>
              <select v-model="planChange.billingPeriod" class="field"><option value="month">{{ t('opsConsole.billing.periodOf.month') }}</option><option value="year">{{ t('opsConsole.billing.periodOf.year') }}</option></select>
            </label>
          </div>
          <label class="field-wrap"><span class="label">{{ t('opsConsole.actionsTab.reason') }}</span><input v-model="planChange.comment" class="field" maxlength="500" placeholder="10–500"></label>
          <div class="chips"><button type="submit" class="btn primary" :disabled="!planChangeReady || busy">{{ t('opsConsole.billing.changeOk') }}</button></div>
        </form>

        <form v-if="can('billing.extend')" class="card" data-testid="ops-billing-extend" @submit.prevent="submitExtend">
          <h2>{{ t('opsConsole.billing.extendTitle') }}</h2>
          <div class="row">
            <label class="field-wrap"><span class="label">{{ t('opsConsole.billing.paidUntil') }}</span><input v-model="extendForm.paidUntil" class="field" type="date"></label>
            <label class="field-wrap"><span class="label">{{ t('opsConsole.billing.aiUntil') }}</span><input v-model="extendForm.aiUntil" class="field" type="date"></label>
          </div>
          <label class="field-wrap"><span class="label">{{ t('opsConsole.actionsTab.reason') }}</span><input v-model="extendForm.comment" class="field" maxlength="500" placeholder="10–500"></label>
          <div class="chips"><button type="submit" class="btn primary" :disabled="!extendReady || busy">{{ t('opsConsole.billing.extendOk') }}</button></div>
        </form>

        <form v-if="can('billing.payments')" class="card" data-testid="ops-billing-payment" @submit.prevent="submitPayment">
          <h2>{{ t('opsConsole.billing.newPayment') }}</h2>
          <div class="row">
            <label class="field-wrap"><span class="label">{{ t('opsConsole.billing.kind') }}</span>
              <select v-model="paymentForm.kind" class="field">
                <option value="subscription">{{ t('opsConsole.billing.kindOf.subscription') }}</option>
                <option value="addon">{{ t('opsConsole.billing.kindOf.addon') }}</option>
                <option value="adjustment">{{ t('opsConsole.billing.kindOf.adjustment') }}</option>
              </select>
            </label>
            <label v-if="paymentForm.kind === 'subscription'" class="field-wrap"><span class="label">{{ t('opsConsole.billing.period') }}</span>
              <select v-model="paymentForm.billingPeriod" class="field"><option value="month">{{ t('opsConsole.billing.periodOf.month') }}</option><option value="year">{{ t('opsConsole.billing.periodOf.year') }}</option></select>
            </label>
            <label v-if="paymentForm.kind === 'addon'" class="field-wrap"><span class="label">{{ t('opsConsole.billing.addonCode') }}</span>
              <input v-model="paymentForm.addonCode" class="field" list="addon-codes" autocomplete="off">
              <datalist id="addon-codes"><option v-for="c in ADDON_CODES" :key="c" :value="c" /></datalist>
            </label>
            <label v-if="paymentForm.kind === 'addon'" class="field-wrap"><span class="label">{{ t('opsConsole.billing.qty') }}</span><input v-model="paymentForm.qty" class="field" type="number" min="1" inputmode="numeric"></label>
            <label class="field-wrap"><span class="label">{{ t('opsConsole.billing.amount') }}</span><input v-model="paymentForm.amount" class="field" type="number" min="0" step="0.01" inputmode="decimal"></label>
            <label class="field-wrap"><span class="label">{{ t('opsConsole.billing.currency') }}</span><input v-model="paymentForm.currency" class="field upper" maxlength="3"></label>
            <label class="field-wrap"><span class="label">{{ t('opsConsole.billing.method') }}</span>
              <select v-model="paymentForm.method" class="field"><option value="bank_transfer">{{ t('opsConsole.billing.methodOf.bank_transfer') }}</option><option value="card">{{ t('opsConsole.billing.methodOf.card') }}</option><option value="manual">{{ t('opsConsole.billing.methodOf.manual') }}</option></select>
            </label>
            <label class="field-wrap"><span class="label">{{ t('opsConsole.billing.invoiceNumber') }}</span><input v-model="paymentForm.invoiceNumber" class="field" autocomplete="off"></label>
          </div>
          <label class="field-wrap"><span class="label">{{ t('opsConsole.actionsTab.reason') }}</span><input v-model="paymentForm.comment" class="field" maxlength="500" placeholder="10–500"></label>
          <div class="chips"><button type="submit" class="btn primary" :disabled="!paymentReady || busy">{{ t('opsConsole.billing.record') }}</button></div>
        </form>

        <div class="card">
          <h2>{{ t('opsConsole.billing.history') }}</h2>
          <p v-if="!payments.length" class="muted">{{ t('opsConsole.billing.empty') }}</p>
          <ul v-else class="payments">
            <li v-for="p in payments" :key="p.id" class="payment">
              <span class="badge">{{ t(`opsConsole.billing.kindOf.${p.kind}`) }}</span>
              <span>{{ (Number(p.amountMinor) / 100).toFixed(2) }} {{ p.currency }}</span>
              <span class="muted">{{ fmt(p.createdAt) }}</span>
              <span class="badge" :class="p.status">{{ t(`opsConsole.billing.paymentStatus.${p.status}`) }}</span>
              <span v-if="p.periodTo" class="muted">{{ t('opsConsole.billing.until', { date: fmt(p.periodTo) }) }}</span>
            </li>
          </ul>
        </div>
      </section>

      <section v-else-if="tab === 'users'">
        <div class="table-wrap">
          <table class="table" data-testid="ops-tenant-users">
            <thead><tr><th>{{ t('opsConsole.tenantUsers.name') }}</th><th>{{ t('opsConsole.tenantUsers.status') }}</th><th>{{ t('opsConsole.tenantUsers.twoFactor') }}</th><th /></tr></thead>
            <tbody>
              <tr v-for="u in users" :key="u.id">
                <td><b>{{ u.fullName }}</b><span class="sub">{{ u.phone }}</span></td>
                <td><span class="badge" :class="u.status === 'active' ? 'teal' : 'muted'">{{ u.status }}</span></td>
                <td><span class="badge" :class="u.twoFactor ? 'teal' : 'muted'">{{ t(u.twoFactor ? 'opsConsole.tenantUsers.tfOn' : 'opsConsole.tenantUsers.tfOff') }}</span></td>
                <td class="actions">
                  <button v-if="u.twoFactor && can('tenant.two_factor_reset')" type="button" class="btn ghost small" @click="resetFor = u; resetReason = ''">{{ t('opsConsole.tenantUsers.reset') }}</button>
                  <button v-if="u.status === 'active' && can('tenant.impersonate')" type="button" class="btn ghost small" @click="impFor = u; impReason = ''">{{ t('opsConsole.tenantUsers.impersonate') }}</button>
                </td>
              </tr>
              <tr v-if="!users.length"><td colspan="4" class="muted">{{ t('opsConsole.tenantUsers.empty') }}</td></tr>
            </tbody>
          </table>
        </div>

        <form v-if="resetFor" class="card" role="dialog" :aria-label="t('opsConsole.tenantUsers.resetTitle', { name: resetFor.fullName })" @submit.prevent="resetTwoFactor">
          <h2>{{ t('opsConsole.tenantUsers.resetTitle', { name: resetFor.fullName }) }}</h2>
          <p class="help">{{ t('opsConsole.tenantUsers.resetHint') }}</p>
          <label class="field-wrap"><span class="label">{{ t('opsConsole.actionsTab.reason') }}</span><textarea v-model="resetReason" class="field" rows="3" maxlength="500" /></label>
          <div class="chips"><button type="button" class="btn ghost" @click="resetFor = null">{{ t('common.cancel') }}</button><button type="submit" class="btn danger" :disabled="resetReason.trim().length < 10 || busy">{{ t('opsConsole.tenantUsers.reset') }}</button></div>
        </form>

        <form v-if="impFor" class="card" role="dialog" :aria-label="t('opsConsole.tenantUsers.impersonate')" @submit.prevent="doImpersonate">
          <h2>{{ t('opsConsole.tenantUsers.impersonate') }}: {{ impFor.fullName }}</h2>
          <p class="help">{{ t('opsConsole.tenantUsers.impersonateWarn') }}</p>
          <label class="field-wrap"><span class="label">{{ t('opsConsole.actionsTab.reason') }}</span><textarea v-model="impReason" class="field" rows="3" maxlength="500" /></label>
          <div class="chips"><button type="button" class="btn ghost" @click="impFor = null">{{ t('common.cancel') }}</button><button type="submit" class="btn primary" :disabled="impReason.trim().length < 10 || busy">{{ t('opsConsole.tenantUsers.enter') }}</button></div>
        </form>
      </section>

      <section v-else-if="tab === 'domain'" class="stack">
        <form class="card" @submit.prevent="saveDomain">
          <h2>{{ t('opsConsole.domainTab.title') }}</h2>
          <p class="help">{{ t('opsConsole.domainTab.hint') }}</p>
          <label class="field-wrap"><span class="label">{{ t('opsConsole.domainTab.value') }}</span><input v-model="domainValue" class="field" placeholder="navchannya.kappi.ua" autocomplete="off"></label>
          <div class="chips"><button type="submit" class="btn primary" :disabled="busy">{{ t('common.save') }}</button></div>
        </form>
        <form class="card" @submit.prevent="saveSmtp">
          <h2>{{ t('opsConsole.domainTab.smtpTitle') }}</h2>
          <p class="help">{{ t('opsConsole.domainTab.smtpHint') }}</p>
          <label class="toggle"><input v-model="ignoreTlsErrors" type="checkbox"><span>{{ t('opsConsole.domainTab.smtpLabel') }}</span></label>
          <div class="chips"><button type="submit" class="btn primary" :disabled="busy">{{ t('common.save') }}</button></div>
        </form>
      </section>

      <section v-else-if="tab === 'lifecycle'">
        <p class="help">{{ t('opsConsole.lifecycleTab.hint') }}</p>
        <div class="cards">
          <article v-for="s in stages" :key="s.id" class="card stage" :class="{ off: !s.isEnabled }">
            <header>
              <b>{{ s.nameUk }}</b><span class="muted">{{ s.code }}</span>
              <span class="spacer" />
              <span class="muted">{{ t('settings.lifecycle.coursesCount') }}: {{ s.coursesCount }}</span>
              <span class="muted">{{ t('settings.lifecycle.peopleCount') }}: {{ s.peopleCount }}</span>
            </header>
            <ul class="caps">
              <li v-for="cap in STAGE_CAPABILITIES" :key="cap">
                <label class="pick">
                  <input type="checkbox" :checked="s.capabilities[cap] === true" :disabled="!can('tenant.update') || savingStage === s.id" @change="toggleCapability(s, cap)">
                  {{ t(`settings.lifecycle.cap.${cap}`) }}
                </label>
              </li>
            </ul>
          </article>
          <p v-if="!stages.length" class="muted">{{ t('opsConsole.lifecycleTab.empty') }}</p>
        </div>
      </section>

      <section v-else-if="tab === 'actions'" class="stack">
        <div class="card">
          <h2>{{ t('opsConsole.tabs.actions') }}</h2>
          <div class="chips">
            <button v-if="data.tenant.status === 'active' && can('tenant.suspend')" type="button" class="btn ghost" @click="openAction('suspend')">{{ t('opsConsole.actionsTab.suspend') }}</button>
            <button v-if="data.tenant.status === 'suspended' && can('tenant.suspend')" type="button" class="btn ghost" @click="openAction('resume')">{{ t('opsConsole.actionsTab.resume') }}</button>
            <button v-if="data.tenant.status === 'suspended' && can('tenant.purge')" type="button" class="btn danger" @click="openAction('purge')">{{ t('opsConsole.actionsTab.purge') }}</button>
            <button v-if="data.tenant.status === 'archived' && can('tenant.purge')" type="button" class="btn ghost" @click="openAction('cancelPurge')">{{ t('opsConsole.actionsTab.cancelPurge') }}</button>
          </div>
          <p v-if="data.tenant.status === 'archived'" class="help coral">{{ t('opsConsole.actionsTab.purgeAt', { date: purgeAt }) }}</p>
        </div>

        <form v-if="actionKind" class="card" role="dialog" :aria-label="t(`opsConsole.actionsTab.confirm.${actionKind}.title`)" @submit.prevent="runAction">
          <h2>{{ t(`opsConsole.actionsTab.confirm.${actionKind}.title`) }}</h2>
          <p class="help">{{ t(`opsConsole.actionsTab.confirm.${actionKind}.text`, { days: PURGE_DAYS }) }}</p>
          <label v-if="actionKind === 'suspend'" class="field-wrap"><span class="label">{{ t('opsConsole.actionsTab.reason') }}</span><input v-model="suspendReason" class="field" maxlength="500"></label>
          <label v-if="actionKind === 'purge'" class="field-wrap"><span class="label">{{ t('opsConsole.actionsTab.typeSlug', { slug: data.tenant.slug }) }}</span><input v-model="confirmSlug" class="field" autocomplete="off" :placeholder="data.tenant.slug"></label>
          <div class="chips"><button type="button" class="btn ghost" @click="actionKind = null">{{ t('common.cancel') }}</button><button type="submit" class="btn" :class="actionKind === 'purge' ? 'danger' : 'primary'" :disabled="!actionReady || busy">{{ t(`opsConsole.actionsTab.confirm.${actionKind}.ok`) }}</button></div>
        </form>
      </section>
    </template>
  </section>
</template>

<style scoped>
.back { display: inline-block; margin-bottom: var(--space-3); }
.title { margin: 0 0 var(--space-3); font-size: var(--font-size-title-l); font-weight: 900; overflow-wrap: anywhere; }
.slug { font-size: var(--font-size-body); font-weight: 700; }
.tabs { margin-bottom: var(--space-4); }
.grid { display: grid; grid-template-columns: repeat(auto-fit, minmax(260px, 1fr)); gap: var(--space-3); margin-bottom: var(--space-3); }
.grid.two { grid-template-columns: repeat(auto-fit, minmax(180px, 1fr)); }
.stack { display: grid; gap: var(--space-3); }
.card { margin-bottom: var(--space-3); }
h2 { margin: 0 0 var(--space-3); font-size: var(--font-size-body); font-weight: 900; }
dl { display: grid; grid-template-columns: auto 1fr; gap: var(--space-1) var(--space-3); margin: 0; }
dt { color: var(--color-ink-muted); }
dd { margin: 0; font-weight: 700; }
.axes, .recent, .payments { list-style: none; margin: 0; padding: 0; display: grid; gap: var(--space-3); }
.axis-head { display: flex; justify-content: space-between; flex-wrap: wrap; gap: var(--space-2); }
.meter { height: var(--space-2); background: var(--color-bg-line-soft); border-radius: var(--radius-pill); overflow: hidden; margin-top: var(--space-1); }
.meter span { display: block; height: 100%; background: var(--color-teal); }
.meter span.warn { background: var(--color-sun); }
.meter span.exceeded { background: var(--color-coral); }
.recent li { overflow-wrap: anywhere; }
.field-wrap { display: grid; gap: var(--space-1); font-size: var(--font-size-body-s); }
.field-wrap em { font-style: normal; }
.field.upper { text-transform: uppercase; }
.row { display: grid; grid-template-columns: repeat(auto-fit, minmax(160px, 1fr)); gap: var(--space-2); margin-bottom: var(--space-2); }
.payment { display: flex; gap: var(--space-2); align-items: center; flex-wrap: wrap; background: var(--color-bg); border-radius: var(--radius-s); padding: var(--space-2) var(--space-3); }
.table .actions { display: flex; gap: var(--space-2); flex-wrap: wrap; }
.coral { color: var(--color-coral-ink); }
.cards { display: grid; grid-template-columns: repeat(auto-fill, minmax(280px, 1fr)); gap: var(--space-3); }
.stage header { display: flex; gap: var(--space-2); align-items: center; margin-bottom: var(--space-2); flex-wrap: wrap; }
.stage.off { opacity: 0.6; }
.spacer { flex: 1; }
.caps { list-style: none; margin: 0; padding: 0; display: grid; gap: var(--space-1); }
.pick { display: inline-flex; align-items: center; gap: var(--space-2); font-size: var(--font-size-body-s); font-weight: 700; }
</style>
