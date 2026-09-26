<script setup lang="ts">
/**
 * Панель оператора платформы — экран PlatformTenants (docs/24 §4.1, docs/25 §7–8, мокап PlatformTenants.html).
 * Отдельный вход, отдельная сессия, отдельный префикс API. Показывает агрегаты, не содержимое (docs/25 §7 п. 4).
 */
const { formatShortDate } = useFormat()
definePageMeta({ layout: false })
const { t } = useI18n()

interface Me { adminId: string, email: string, fullName: string, hostBase: string | null }
interface Tenant {
  id: string, slug: string, name: string, status: 'active' | 'suspended' | 'archived', plan: string, trial_ends_at: string | null, created_at: string, archived_at: string | null
  users_limit: number | null, storage_gb_limit: number | null, sms_limit: number | null, active_jobs_limit: number | null, has_overrides: boolean
  active_users: number, total_users: number, wau: number, media_bytes: string, completed_30d: number
  custom_domain: string | null
}
interface Plan { code: string, name: string, maxUsers: number | null, priceUah: number | null }
/**
 * Одиннадцать осей лимита (docs/v2/35 §7.1, решение docs/v2/44 В-5): десять тарифицируемых
 * плюс `activeJobs` — квота задач воркера (docs/25 §5), ось вне пакета. Мягкая `telegram_out`
 * поля не имеет: лимита у неё нет. Эффективное значение (тариф + переопределение + доплаты)
 * считает сервер одной функцией — экран его показывает, а не пересчитывает.
 */
interface Limits {
  plan: { code: string, users: number | null, storageGb: number | null, smsPerMonth: number | null, candidates: number | null, aiGenerateOps: number | null, aiReviewOps: number | null, aiInterviewOps: number | null, exportRows: number | null }
  overrides: { users: number | null, storageGb: number | null, smsPerMonth: number | null, apiPerMinute: number | null, webhooks: number | null, activeJobs: number | null, candidates: number | null, aiGenerateOps: number | null, aiReviewOps: number | null, aiInterviewOps: number | null, exportRows: number | null }
  /** Состояние подписки (docs/v2/35 §3.2, §5.6) — PR-10, панель «Тариф і оплата». */
  subscription: { billingPeriod: 'month' | 'year', status: string, paidUntil: string | null, graceUntil: string | null, aiUntil: string | null, autorenew: boolean, currency: string, aiStatus: string }
}
/** История платежей тенанта (docs/v2/35 §3.5, §5.6, PR-10): без пагинации, платежей у тенанта немного. */
interface Payment {
  id: string, kind: 'subscription' | 'addon' | 'adjustment', planCode: string | null, addonCode: string | null
  billingPeriod: string | null, periodFrom: string | null, periodTo: string | null, amountMinor: number | string, currency: string
  status: string, method: string | null, invoiceNumber: string | null, comment: string | null, createdAt: string
}
/** Пять кодов каталога опций §3.4 — фиксированный перечень схемы, не выдуманный (seed 0059_v2_billing_plans). */
const ADDON_CODES = ['storage_pack', 'ai_ops_pack', 'sms_pack', 'candidates_pack', 'ai_term']
type LimitKey = keyof Limits['overrides']
type PlanLimitKey = keyof Limits['plan']
const LIMIT_KEYS: LimitKey[] = ['users', 'candidates', 'storageGb', 'smsPerMonth', 'aiGenerateOps', 'aiReviewOps', 'aiInterviewOps', 'exportRows', 'apiPerMinute', 'webhooks', 'activeJobs']
/** У каких осей лимит задаётся и тарифом — рядом с полем показываем значение тарифа. */
const PLAN_LIMIT_KEYS = new Set<LimitKey>(['users', 'candidates', 'storageGb', 'smsPerMonth', 'aiGenerateOps', 'aiReviewOps', 'aiInterviewOps', 'exportRows'])
const PURGE_DAYS = 30

const me = ref<Me | null>(null)
const login = reactive({ email: '', password: '' })
const tenants = ref<Tenant[]>([])
const plans = ref<Plan[]>([])
const metrics = ref<Record<string, unknown> | null>(null)
const error = ref('')
const notice = ref('')
const busy = ref(false)
const showCreate = ref(false)
const newTenant = reactive({ slug: '', name: '', adminName: '', adminPhone: '', plan: 'trial' })
const impFor = ref<Tenant | null>(null)
const impUsers = ref<{ id: string, fullName: string, phone: string | null, status: string, twoFactor?: boolean }[]>([])
/**
 * Сброс второго фактора (docs/24 §3.4, PR-39) — последний способ вернуть вход администратору,
 * потерявшему телефон и резервные коды, когда другого администратора нет. С причиной: клиент
 * увидит её в своём журнале безопасности.
 */
const tfFor = ref<Tenant | null>(null)
const tfForm = reactive({ userId: '', reason: '' })
/**
 * Объявления платформы (docs/v2/39 П-21, П-24.2; docs/24 §4.7): вторая «новость» — от Lola всем
 * пространствам, по тарифу или конкретным. Это не новости компании: тенант их только читает.
 */
interface Announcement { id: string, title: string, body: string, audience: 'all' | 'plans' | 'tenants', planCodes: string[], tenantIds: string[], publishedAt: string | null, archivedAt: string | null, createdAt: string, readers: number }
const announcements = ref<Announcement[]>([])
const annForm = reactive({ title: '', body: '', audience: 'all' as Announcement['audience'], planCodes: [] as string[], tenantIds: [] as string[], publish: true })
const annReady = computed(() => annForm.title.trim().length >= 3 && annForm.body.trim().length > 0
  && (annForm.audience !== 'plans' || annForm.planCodes.length > 0) && (annForm.audience !== 'tenants' || annForm.tenantIds.length > 0))
const annState = (a: Announcement) => a.archivedAt ? 'archived' : a.publishedAt ? 'published' : 'draft'
const impForm = reactive({ userId: '', reason: '' })
/** Диалог действия над тенантом: suspend — с причиной, purge — с подтверждением slug, resume/cancelPurge — просто подтвердить. */
const action = ref<{ kind: 'suspend' | 'resume' | 'purge' | 'cancelPurge', tenant: Tenant } | null>(null)
const actionForm = reactive({ reason: '', confirmSlug: '' })
const limitsFor = ref<Tenant | null>(null)
const limits = ref<Limits | null>(null)
const limitsForm = reactive<Record<LimitKey, string>>({ users: '', storageGb: '', smsPerMonth: '', apiPerMinute: '', webhooks: '', activeJobs: '', candidates: '', aiGenerateOps: '', aiReviewOps: '', aiInterviewOps: '', exportRows: '' })
/** Собственный домен клиента (докс/33 D-059): CNAME на платформу, сертификат — вручную, docs/27. */
const domainFor = ref<Tenant | null>(null)
const domainForm = reactive({ value: '' })
/**
 * «Тариф і оплата» (docs/v2/35 §5.6, PR-10): підписка, історія платежів, приймання платежу
 * вручну — провайдера немає (`44` §8). `qty` — тільки для kind='addon' (кількість кроків §3.4).
 */
const billingFor = ref<Tenant | null>(null)
const payments = ref<Payment[]>([])
const paymentForm = reactive({
  kind: 'subscription' as 'subscription' | 'addon' | 'adjustment',
  billingPeriod: 'month' as 'month' | 'year',
  addonCode: '', qty: '1', amount: '', currency: 'EUR',
  method: 'bank_transfer' as 'bank_transfer' | 'card' | 'manual',
  invoiceNumber: '', comment: '',
})
/** Точечное продление дат без платежа (§5.6 «Продовжити доступ» / «Продовжити ШІ», §7.10). */
const extendForm = reactive({ paidUntil: '', aiUntil: '', comment: '' })
/** Заявка на зміну тарифу (`plan_change_requests`, §7.10): оператор призначає план напряму, без preflight, але з причиною. */
const planChangeFor = ref<{ tenant: Tenant, toPlanCode: string } | null>(null)
const planChangeForm = reactive({ billingPeriod: 'month' as 'month' | 'year', comment: '' })
function openDomain(tn: Tenant) { domainFor.value = tn; domainForm.value = tn.custom_domain ?? ''; error.value = '' }
async function saveDomain() {
  if (!domainFor.value) return
  error.value = ''
  try {
    await ops(`/tenants/${domainFor.value.id}`, { method: 'PATCH', body: { customDomain: domainForm.value.trim() || null } })
    notice.value = t('ops.done.domain', { name: domainFor.value.name })
    domainFor.value = null
    await load()
  }
  catch (err) { error.value = apiErrorOf(err).message }
}

/**
 * «Тариф і оплата» (docs/v2/35 §5.6): підписка з `/limits` (те саме `effectiveLimits().subscription`,
 * що й на екрані власника), історія платежів з `/payments`. Одна точка правди — сервер.
 */
async function openBilling(tn: Tenant) {
  error.value = ''
  billingFor.value = tn
  ;[limits.value, payments.value] = await Promise.all([ops<Limits>(`/tenants/${tn.id}/limits`), ops<Payment[]>(`/tenants/${tn.id}/payments`)])
  Object.assign(paymentForm, { kind: 'subscription', billingPeriod: limits.value.subscription.billingPeriod, addonCode: '', qty: '1', amount: '', currency: limits.value.subscription.currency, method: 'bank_transfer', invoiceNumber: '' })
  paymentForm.comment = ''
  Object.assign(extendForm, { paidUntil: limits.value.subscription.paidUntil ?? '', aiUntil: limits.value.subscription.aiUntil ?? '', comment: '' })
}
const extendReady = computed(() => extendForm.comment.trim().length >= 10)
async function submitExtend() {
  if (!billingFor.value || !extendReady.value || busy.value) return
  error.value = ''
  busy.value = true
  try {
    await ops(`/tenants/${billingFor.value.id}/extend`, { method: 'POST', body: { paidUntil: extendForm.paidUntil || null, aiUntil: extendForm.aiUntil || null, comment: extendForm.comment.trim() } })
    notice.value = t('ops.done.extend', { name: billingFor.value.name })
    await openBilling(billingFor.value)
    await load()
  }
  catch (err) { error.value = apiErrorOf(err).message }
  finally { busy.value = false }
}
const paymentReady = computed(() => paymentForm.comment.trim().length >= 10 && paymentForm.amount !== '' && Number(paymentForm.amount) >= 0 && (paymentForm.kind !== 'addon' || paymentForm.addonCode !== ''))
async function submitPayment() {
  if (!billingFor.value || !paymentReady.value || busy.value) return
  error.value = ''
  busy.value = true
  try {
    await ops(`/tenants/${billingFor.value.id}/payments`, {
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
    notice.value = t('ops.done.payment', { name: billingFor.value.name })
    await openBilling(billingFor.value)
    await load()
  }
  catch (err) { error.value = apiErrorOf(err).message }
  finally { busy.value = false }
}

/** Зміна тарифу з причиною (§7.10) — замінює миттєвий `setPlan` діалогом підтвердження. */
function openPlanChange(tn: Tenant, toPlanCode: string) {
  if (toPlanCode === tn.plan) return
  error.value = ''
  planChangeFor.value = { tenant: tn, toPlanCode }
  planChangeForm.billingPeriod = 'month'
  planChangeForm.comment = ''
}
async function submitPlanChange() {
  if (!planChangeFor.value || planChangeForm.comment.trim().length < 10 || busy.value) return
  error.value = ''
  busy.value = true
  try {
    await ops(`/tenants/${planChangeFor.value.tenant.id}/plan-change`, { method: 'POST', body: { toPlanCode: planChangeFor.value.toPlanCode, billingPeriod: planChangeForm.billingPeriod, comment: planChangeForm.comment.trim() } })
    notice.value = t('ops.done.planChange', { name: planChangeFor.value.tenant.name })
    planChangeFor.value = null
    await load()
  }
  catch (err) { error.value = apiErrorOf(err).message }
  finally { busy.value = false }
}

// Нетипизированный вызов: типизированные роуты Nitro при сотнях эндпоинтов дают TS2589
const rawFetch = $fetch as unknown as <T>(url: string, opts?: unknown) => Promise<T>
async function ops<T>(path: string, opts: Record<string, unknown> = {}): Promise<T> {
  const res = await rawFetch<{ data: T }>(`/api/v1/platform${path}`, opts)
  return res.data
}

async function load() {
  try {
    // Вход и второй фактор — экранами новой консоли (docs/25 §7 п. 8): своего входа у прежней панели больше нет
    const who = await ops<Me & { twoFactor: string | null }>('/me').catch(() => null)
    if (!who) return navigateTo('/ops/login')
    if (who.twoFactor) return navigateTo('/ops/two-factor')
    me.value = who
    ;[tenants.value, plans.value, metrics.value, announcements.value] = await Promise.all([ops<Tenant[]>('/tenants'), ops<Plan[]>('/plans'), ops<Record<string, unknown>>('/metrics'), ops<Announcement[]>('/announcements')])
  }
  catch { me.value = null }
}

async function createAnnouncement() {
  if (!annReady.value || busy.value) return
  error.value = ''
  busy.value = true
  try {
    await ops('/announcements', { method: 'POST', body: {
      title: annForm.title.trim(), body: annForm.body.trim(), audience: annForm.audience, publish: annForm.publish,
      planCodes: annForm.audience === 'plans' ? annForm.planCodes : [], tenantIds: annForm.audience === 'tenants' ? annForm.tenantIds : [],
    } })
    notice.value = t('ops.ann.created')
    Object.assign(annForm, { title: '', body: '', audience: 'all', planCodes: [], tenantIds: [], publish: true })
    announcements.value = await ops<Announcement[]>('/announcements')
  }
  catch (err) { error.value = apiErrorOf(err).message }
  finally { busy.value = false }
}
async function announcementAction(a: Announcement, kind: 'publish' | 'archive') {
  if (kind === 'archive' && !confirm(t('ops.ann.archiveConfirm', { title: a.title }))) return
  error.value = ''
  try {
    await ops(`/announcements/${a.id}/${kind}`, { method: 'POST' })
    announcements.value = await ops<Announcement[]>('/announcements')
  }
  catch (err) { error.value = apiErrorOf(err).message }
}

async function openTwoFactorReset(tn: Tenant) {
  error.value = ''
  tfFor.value = tn
  impUsers.value = await ops(`/tenants/${tn.id}/users`)
  tfForm.userId = ''
  tfForm.reason = ''
}
async function resetTwoFactor() {
  if (!tfFor.value || !tfForm.userId || tfForm.reason.trim().length < 10 || busy.value) return
  error.value = ''
  busy.value = true
  try {
    await ops(`/tenants/${tfFor.value.id}/users/${tfForm.userId}/two-factor-reset`, { method: 'POST', body: { reason: tfForm.reason.trim() } })
    notice.value = t('ops.tf.done', { name: impUsers.value.find(u => u.id === tfForm.userId)?.fullName ?? '' })
    tfFor.value = null
  }
  catch (err) { error.value = apiErrorOf(err).message }
  finally { busy.value = false }
}
onMounted(load)

async function doLogin() {
  error.value = ''
  try { await ops('/login', { method: 'POST', body: login }); await load() }
  catch (err) { error.value = apiErrorOf(err).message }
}
async function logout() { await ops('/logout', { method: 'POST' }); me.value = null }

async function createTenant() {
  error.value = ''
  try {
    await ops('/tenants', { method: 'POST', body: { ...newTenant, adminPhone: `+380${newTenant.adminPhone.replace(/\D/g, '')}` } })
    notice.value = t('ops.created', { slug: newTenant.slug })
    Object.assign(newTenant, { slug: '', name: '', adminName: '', adminPhone: '' })
    showCreate.value = false
    await load()
  }
  catch (err) { error.value = apiErrorOf(err).message }
}
function openAction(kind: NonNullable<typeof action.value>['kind'], tenant: Tenant) {
  actionForm.reason = ''
  actionForm.confirmSlug = ''
  action.value = { kind, tenant }
}
const actionReady = computed(() => !action.value || action.value.kind !== 'purge' || actionForm.confirmSlug.trim() === action.value.tenant.slug)
async function runAction() {
  if (!action.value || !actionReady.value || busy.value) return
  const { kind, tenant } = action.value
  error.value = ''
  busy.value = true
  try {
    if (kind === 'suspend') await ops(`/tenants/${tenant.id}/suspend`, { method: 'POST', body: { reason: actionForm.reason || undefined } })
    if (kind === 'resume') await ops(`/tenants/${tenant.id}/resume`, { method: 'POST' })
    if (kind === 'purge') await ops(`/tenants/${tenant.id}/purge`, { method: 'POST', body: { confirmSlug: actionForm.confirmSlug.trim() } })
    if (kind === 'cancelPurge') await ops(`/tenants/${tenant.id}/purge`, { method: 'DELETE' })
    notice.value = t(`ops.done.${kind}`, { name: tenant.name })
    action.value = null
    await load()
  }
  catch (err) { error.value = apiErrorOf(err).message }
  finally { busy.value = false }
}

async function openLimits(tn: Tenant) {
  error.value = ''
  limitsFor.value = tn
  limits.value = await ops<Limits>(`/tenants/${tn.id}/limits`)
  for (const k of LIMIT_KEYS) limitsForm[k] = limits.value.overrides[k] == null ? '' : String(limits.value.overrides[k])
}
async function saveLimits() {
  if (!limitsFor.value) return
  error.value = ''
  const body = Object.fromEntries(LIMIT_KEYS.map(k => [k, limitsForm[k].trim() === '' ? null : Number(limitsForm[k])]))
  try {
    await ops(`/tenants/${limitsFor.value.id}/limits`, { method: 'PUT', body })
    notice.value = t('ops.done.limits', { name: limitsFor.value.name })
    limitsFor.value = null
    await load()
  }
  catch (err) { error.value = apiErrorOf(err).message }
}

async function openImpersonate(tn: Tenant) {
  impFor.value = tn
  impUsers.value = await ops(`/tenants/${tn.id}/users`)
  impForm.userId = ''
  impForm.reason = ''
}
async function impersonate() {
  if (!impFor.value) return
  error.value = ''
  try {
    // С отдельным хостом консоли (OPS_HOST) сервер отдаёт одноразовую ссылку на хост тенанта (docs/25 §7 п. 6)
    const r = await ops<{ handoffUrl: string | null }>(`/tenants/${impFor.value.id}/impersonate`, { method: 'POST', body: impForm })
    window.open(r.handoffUrl ?? '/', '_blank')
    impFor.value = null
  }
  catch (err) { error.value = apiErrorOf(err).message }
}

const hostOf = (tn: Tenant) => tn.custom_domain || (me.value?.hostBase ? `${tn.slug}.${me.value.hostBase}` : tn.slug)
const gb = (b: string | number) => (Number(b) / 1024 / 1024 / 1024).toFixed(1)
const fmt = (d: string | null) => d ? formatShortDate(new Date(d)) : '—'
const purgeAt = (tn: Tenant) => tn.archived_at ? fmt(new Date(new Date(tn.archived_at).getTime() + PURGE_DAYS * 86_400_000).toISOString()) : '—'
const planName = (code: string) => plans.value.find(p => p.code === code)?.name ?? code
/** Тріал показывается как состояние, если тариф trial и тенант активен (мокап: «Тріал») */
const stateOf = (tn: Tenant) => tn.status === 'active' && tn.plan === 'trial' ? 'trial' : tn.status
const kpiKeys = ['tenants_active', 'trials_ending', 'users_active', 'dau', 'wau', 'attempts_today', 'notifications_queued', 'notifications_failed_24h', 'webhooks_failed_24h']
</script>

<template>
  <div class="ops">
    <header class="top">
      <div class="brand"><span class="dots"><i class="sun" /><i class="teal" /><i class="coral" /><i class="ink" /></span><b>Lola · {{ t('ops.title') }}</b></div>
      <span v-if="me" class="who">{{ me.email }} <button type="button" class="chip" @click="logout">{{ t('home.logout') }}</button></span>
    </header>
    <p v-if="error" class="error" role="alert">{{ error }}</p>
    <p v-if="notice" class="notice" role="status">{{ notice }} <button type="button" class="link" @click="notice = ''">×</button></p>

    <main v-if="!me" class="login">
      <label class="field"><span>E-mail</span><input v-model="login.email" type="email" autocomplete="username" @keyup.enter="doLogin"></label>
      <label class="field"><span>{{ t('ops.password') }}</span><input v-model="login.password" type="password" autocomplete="current-password" @keyup.enter="doLogin"></label>
      <button type="button" class="primary" @click="doLogin">{{ t('login.signIn') }}</button>
    </main>

    <main v-else class="body">
      <div class="head">
        <div><div class="eyebrow">{{ t('ops.platform') }}</div><h1>{{ t('ops.tenants') }}</h1></div>
        <button type="button" class="primary" @click="showCreate = !showCreate">{{ t('ops.newTenant') }}</button>
      </div>
      <p class="hint">{{ t('ops.hint') }}</p>

      <div v-if="metrics" class="kpis">
        <div v-for="k in kpiKeys" :key="k" :class="['kpi', { coral: k.includes('failed') && Number(metrics[k]) > 0 }]">
          <b>{{ metrics[k] }}</b><span>{{ t(`ops.kpi.${k}`) }}</span>
        </div>
        <div class="kpi"><b>{{ gb(String(metrics.media_bytes)) }} GB</b><span>{{ t('ops.kpi.media') }}</span></div>
      </div>

      <section v-if="showCreate" class="card">
        <h2>{{ t('ops.newTenant') }}</h2>
        <div class="grid">
          <label class="field"><span>{{ t('ops.f.name') }}</span><input v-model="newTenant.name"></label>
          <label class="field"><span>slug</span><input v-model="newTenant.slug" placeholder="a-z, 0-9, -"></label>
          <label class="field"><span>{{ t('ops.f.adminName') }}</span><input v-model="newTenant.adminName"></label>
          <label class="field"><span>{{ t('ops.f.adminPhone') }}</span><div class="phone"><span>+380</span><input v-model="newTenant.adminPhone" inputmode="numeric" maxlength="9" placeholder="__ ___ __ __"></div></label>
          <label class="field"><span>{{ t('ops.col.plan') }}</span><select v-model="newTenant.plan"><option v-for="p in plans" :key="p.code" :value="p.code">{{ p.name }}</option></select></label>
          <div class="field end"><button type="button" class="primary" :disabled="!newTenant.name || !newTenant.slug || !newTenant.adminName || newTenant.adminPhone.replace(/\D/g, '').length !== 9" @click="createTenant">{{ t('ops.create') }}</button></div>
        </div>
        <p class="sub">{{ t('ops.createHint') }}</p>
      </section>

      <div class="table-wrap">
        <table class="table">
          <thead><tr><th>{{ t('ops.col.tenant') }}</th><th>{{ t('ops.col.plan') }}</th><th>{{ t('ops.col.active') }}</th><th>{{ t('ops.col.disk') }}</th><th>{{ t('ops.col.created') }}</th><th>{{ t('ops.col.state') }}</th><th class="sr-only">{{ t('ops.col.actions') }}</th></tr></thead>
          <tbody>
            <tr v-for="tn in tenants" :key="tn.id" class="row">
              <td data-label="tenant"><strong>{{ tn.name }}</strong><div class="sub">{{ hostOf(tn) }}</div></td>
              <td :data-label="t('ops.col.plan')">
                <label class="sr-only" :for="`plan-${tn.id}`">{{ t('ops.col.plan') }}</label>
                <select :id="`plan-${tn.id}`" :class="['badge', 'plan', tn.plan]" :value="tn.plan" @change="openPlanChange(tn, ($event.target as HTMLSelectElement).value)"><option v-for="p in plans" :key="p.code" :value="p.code">{{ p.name }}</option></select>
              </td>
              <td :data-label="t('ops.col.active')">
                <button type="button" class="link" :title="t('ops.limits.title')" @click="openLimits(tn)">{{ tn.active_users }} / {{ tn.users_limit ?? '∞' }}<span v-if="tn.has_overrides" class="star" :title="t('ops.limits.overridden')">*</span></button>
              </td>
              <td :data-label="t('ops.col.disk')">{{ gb(tn.media_bytes) }} {{ t('ops.gb') }}<span v-if="tn.storage_gb_limit" class="sub"> / {{ tn.storage_gb_limit }}</span></td>
              <td :data-label="t('ops.col.created')">{{ fmt(tn.created_at) }}</td>
              <td :data-label="t('ops.col.state')">
                <span :class="['badge', stateOf(tn)]">{{ t(`ops.state.${stateOf(tn)}`) }}</span>
                <div v-if="tn.status === 'active' && tn.plan === 'trial'" class="sub">{{ t('ops.col.trial') }} {{ fmt(tn.trial_ends_at) }}</div>
                <div v-if="tn.status === 'archived'" class="sub coral">{{ t('ops.purgeAt', { date: purgeAt(tn) }) }}</div>
              </td>
              <td class="acts">
                <button v-if="tn.status === 'active'" type="button" class="chip" @click="openAction('suspend', tn)">{{ t('ops.suspend') }}</button>
                <button v-if="tn.status === 'suspended'" type="button" class="chip" @click="openAction('resume', tn)">{{ t('ops.resume') }}</button>
                <button v-if="tn.status === 'suspended'" type="button" class="chip warn" @click="openAction('purge', tn)">{{ t('ops.purge') }}</button>
                <button v-if="tn.status === 'archived'" type="button" class="chip" @click="openAction('cancelPurge', tn)">{{ t('ops.cancelPurge') }}</button>
                <button type="button" class="chip" @click="openLimits(tn)">{{ t('ops.limits.title') }}</button>
                <button type="button" class="chip" @click="openBilling(tn)">{{ t('ops.billing.title') }}</button>
                <button type="button" class="chip" @click="openDomain(tn)">{{ t('ops.domain.title') }}</button>
                <button v-if="tn.status === 'active'" type="button" class="chip warn" @click="openImpersonate(tn)">{{ t('ops.impersonate') }}</button>
                <button v-if="tn.status === 'active'" type="button" class="chip" @click="openTwoFactorReset(tn)">{{ t('ops.tf.open') }}</button>
              </td>
            </tr>
          </tbody>
        </table>
      </div>

      <section class="card" data-testid="ops-announcements">
        <h2>{{ t('ops.ann.title') }}</h2>
        <p class="sub">{{ t('ops.ann.hint') }}</p>
        <div class="grid">
          <label class="field"><span>{{ t('ops.ann.f.title') }}</span><input v-model="annForm.title" maxlength="200"></label>
          <label class="field"><span>{{ t('ops.ann.f.audience') }}</span>
            <select v-model="annForm.audience"><option v-for="a in ['all', 'plans', 'tenants']" :key="a" :value="a">{{ t(`ops.ann.audience.${a}`) }}</option></select>
          </label>
        </div>
        <label class="field"><span>{{ t('ops.ann.f.body') }}</span><textarea v-model="annForm.body" class="area" rows="4" maxlength="5000" /></label>
        <fieldset v-if="annForm.audience === 'plans'" class="picks">
          <legend class="sub">{{ t('ops.ann.f.plans') }}</legend>
          <label v-for="p in plans" :key="p.code" class="pick"><input v-model="annForm.planCodes" type="checkbox" :value="p.code">{{ p.name }}</label>
        </fieldset>
        <fieldset v-if="annForm.audience === 'tenants'" class="picks">
          <legend class="sub">{{ t('ops.ann.f.tenants') }}</legend>
          <label v-for="tn in tenants" :key="tn.id" class="pick"><input v-model="annForm.tenantIds" type="checkbox" :value="tn.id">{{ tn.name }}</label>
        </fieldset>
        <label class="pick"><input v-model="annForm.publish" type="checkbox">{{ t('ops.ann.f.publish') }}</label>
        <div class="actions"><button type="button" class="primary" :disabled="!annReady || busy" @click="createAnnouncement">{{ t('ops.ann.create') }}</button></div>
        <ul v-if="announcements.length" class="payments">
          <li v-for="a in announcements" :key="a.id" class="payment">
            <span :class="['badge', annState(a) === 'published' ? 'paid' : annState(a) === 'draft' ? 'pending' : 'failed']">{{ t(`ops.ann.state.${annState(a)}`) }}</span>
            <strong>{{ a.title }}</strong>
            <span class="sub">{{ t(`ops.ann.audience.${a.audience}`) }} · {{ fmt(a.publishedAt ?? a.createdAt) }} · {{ t('ops.ann.readers', { n: a.readers }) }}</span>
            <button v-if="annState(a) === 'draft'" type="button" class="chip" @click="announcementAction(a, 'publish')">{{ t('ops.ann.publish') }}</button>
            <button v-if="annState(a) === 'published'" type="button" class="chip warn" @click="announcementAction(a, 'archive')">{{ t('ops.ann.archive') }}</button>
          </li>
        </ul>
      </section>
    </main>

    <div v-if="action" class="modal-backdrop" @click.self="action = null" @keydown.esc="action = null">
      <div class="modal" role="dialog" aria-modal="true" :aria-label="t(`ops.confirm.${action.kind}.title`)">
        <h2>{{ t(`ops.confirm.${action.kind}.title`) }}: {{ action.tenant.name }}</h2>
        <p class="sub">{{ t(`ops.confirm.${action.kind}.text`, { days: PURGE_DAYS }) }}</p>
        <label v-if="action.kind === 'suspend'" class="field"><span>{{ t('ops.confirm.reason') }}</span><input v-model="actionForm.reason" maxlength="500"></label>
        <label v-if="action.kind === 'purge'" class="field"><span>{{ t('ops.confirm.typeSlug', { slug: action.tenant.slug }) }}</span><input v-model="actionForm.confirmSlug" autocomplete="off" :placeholder="action.tenant.slug"></label>
        <div class="actions">
          <button type="button" class="chip" @click="action = null">{{ t('common.cancel') }}</button>
          <button type="button" :class="action.kind === 'purge' ? 'danger' : 'primary'" :disabled="!actionReady || busy" @click="runAction">{{ t(`ops.confirm.${action.kind}.ok`) }}</button>
        </div>
      </div>
    </div>

    <div v-if="limitsFor && limits" class="modal-backdrop" @click.self="limitsFor = null" @keydown.esc="limitsFor = null">
      <div class="modal" role="dialog" aria-modal="true" :aria-label="t('ops.limits.title')">
        <h2>{{ t('ops.limits.title') }}: {{ limitsFor.name }}</h2>
        <p class="sub">{{ t('ops.limits.hint', { plan: planName(limits.plan.code) }) }}</p>
        <div class="grid two">
          <label v-for="k in LIMIT_KEYS" :key="k" class="field">
            <span>{{ t(`ops.limits.${k}`) }}<em v-if="PLAN_LIMIT_KEYS.has(k)" class="sub"> · {{ t('ops.limits.plan') }}: {{ limits.plan[k as PlanLimitKey] ?? '∞' }}</em></span>
            <input v-model="limitsForm[k]" type="number" min="0" inputmode="numeric" :placeholder="t('ops.limits.fromPlan')">
          </label>
        </div>
        <div class="actions"><button type="button" class="chip" @click="limitsFor = null">{{ t('common.cancel') }}</button><button type="button" class="primary" @click="saveLimits">{{ t('common.save') }}</button></div>
      </div>
    </div>

    <div v-if="domainFor" class="modal-backdrop" @click.self="domainFor = null" @keydown.esc="domainFor = null">
      <div class="modal" role="dialog" aria-modal="true" :aria-label="t('ops.domain.title')">
        <h2>{{ t('ops.domain.title') }}: {{ domainFor.name }}</h2>
        <p class="sub">{{ t('ops.domain.hint') }}</p>
        <label class="field"><span>{{ t('ops.domain.value') }}</span><input v-model="domainForm.value" placeholder="navchannya.kappi.ua" autocomplete="off"></label>
        <p v-if="error" class="error">{{ error }}</p>
        <div class="actions"><button type="button" class="chip" @click="domainFor = null">{{ t('common.cancel') }}</button><button type="button" class="primary" @click="saveDomain">{{ t('common.save') }}</button></div>
      </div>
    </div>

    <div v-if="billingFor && limits" class="modal-backdrop" @click.self="billingFor = null" @keydown.esc="billingFor = null">
      <div class="modal wide" role="dialog" aria-modal="true" :aria-label="t('ops.billing.title')">
        <h2>{{ t('ops.billing.title') }}: {{ billingFor.name }}</h2>
        <dl class="kv">
          <dt>{{ t('ops.billing.status') }}</dt><dd><span :class="['badge', limits.subscription.status]">{{ t(`ops.billing.state.${limits.subscription.status}`) }}</span></dd>
          <dt>{{ t('ops.billing.paidUntil') }}</dt><dd>{{ fmt(limits.subscription.paidUntil) }}</dd>
          <dt>{{ t('ops.billing.aiUntil') }}</dt><dd>{{ fmt(limits.subscription.aiUntil) }} <span class="sub">({{ t(`ops.billing.aiState.${limits.subscription.aiStatus}`) }})</span></dd>
          <dt>{{ t('ops.billing.period') }}</dt><dd>{{ t(`ops.billing.periodOf.${limits.subscription.billingPeriod}`) }}</dd>
        </dl>

        <h3>{{ t('ops.billing.extendTitle') }}</h3>
        <div class="grid two">
          <label class="field"><span>{{ t('ops.billing.paidUntil') }}</span><input v-model="extendForm.paidUntil" type="date"></label>
          <label class="field"><span>{{ t('ops.billing.aiUntil') }}</span><input v-model="extendForm.aiUntil" type="date"></label>
        </div>
        <label class="field"><span>{{ t('ops.confirm.reason') }}</span><input v-model="extendForm.comment" maxlength="500" placeholder="10–500"></label>
        <div class="actions"><button type="button" class="primary" :disabled="!extendReady || busy" @click="submitExtend">{{ t('ops.billing.extendOk') }}</button></div>

        <h3>{{ t('ops.billing.newPayment') }}</h3>
        <div class="grid two">
          <label class="field"><span>{{ t('ops.billing.kind') }}</span>
            <select v-model="paymentForm.kind">
              <option value="subscription">{{ t('ops.billing.kindOf.subscription') }}</option>
              <option value="addon">{{ t('ops.billing.kindOf.addon') }}</option>
              <option value="adjustment">{{ t('ops.billing.kindOf.adjustment') }}</option>
            </select>
          </label>
          <label v-if="paymentForm.kind === 'subscription'" class="field"><span>{{ t('ops.billing.period') }}</span>
            <select v-model="paymentForm.billingPeriod"><option value="month">{{ t('ops.billing.periodOf.month') }}</option><option value="year">{{ t('ops.billing.periodOf.year') }}</option></select>
          </label>
          <label v-if="paymentForm.kind === 'addon'" class="field"><span>{{ t('ops.billing.addonCode') }}</span>
            <input v-model="paymentForm.addonCode" list="addon-codes" autocomplete="off">
            <datalist id="addon-codes"><option v-for="c in ADDON_CODES" :key="c" :value="c" /></datalist>
          </label>
          <label v-if="paymentForm.kind === 'addon'" class="field"><span>{{ t('ops.billing.qty') }}</span><input v-model="paymentForm.qty" type="number" min="1" inputmode="numeric"></label>
          <label class="field"><span>{{ t('ops.billing.amount') }}</span><input v-model="paymentForm.amount" type="number" min="0" step="0.01" inputmode="decimal"></label>
          <label class="field"><span>{{ t('ops.billing.currency') }}</span><input v-model="paymentForm.currency" maxlength="3" style="text-transform: uppercase;"></label>
          <label class="field"><span>{{ t('ops.billing.method') }}</span>
            <select v-model="paymentForm.method"><option value="bank_transfer">{{ t('ops.billing.methodOf.bank_transfer') }}</option><option value="card">{{ t('ops.billing.methodOf.card') }}</option><option value="manual">{{ t('ops.billing.methodOf.manual') }}</option></select>
          </label>
          <label class="field"><span>{{ t('ops.billing.invoiceNumber') }}</span><input v-model="paymentForm.invoiceNumber" autocomplete="off"></label>
        </div>
        <label class="field"><span>{{ t('ops.confirm.reason') }}</span><input v-model="paymentForm.comment" maxlength="500" placeholder="10–500"></label>
        <p v-if="error" class="error">{{ error }}</p>
        <div class="actions"><button type="button" class="chip" @click="billingFor = null">{{ t('common.cancel') }}</button><button type="button" class="primary" :disabled="!paymentReady || busy" @click="submitPayment">{{ t('ops.billing.record') }}</button></div>

        <h3>{{ t('ops.billing.history') }}</h3>
        <p v-if="!payments.length" class="sub">{{ t('ops.billing.empty') }}</p>
        <ul v-else class="payments">
          <li v-for="p in payments" :key="p.id" class="payment">
            <span class="badge">{{ t(`ops.billing.kindOf.${p.kind}`) }}</span>
            <span>{{ (Number(p.amountMinor) / 100).toFixed(2) }} {{ p.currency }}</span>
            <span class="sub">{{ fmt(p.createdAt) }}</span>
            <span :class="['badge', p.status]">{{ t(`ops.billing.paymentStatus.${p.status}`) }}</span>
            <span v-if="p.periodTo" class="sub">{{ t('ops.billing.until', { date: fmt(p.periodTo) }) }}</span>
          </li>
        </ul>
      </div>
    </div>

    <div v-if="planChangeFor" class="modal-backdrop" @click.self="planChangeFor = null" @keydown.esc="planChangeFor = null">
      <div class="modal" role="dialog" aria-modal="true" :aria-label="t('ops.planChange.title')">
        <h2>{{ t('ops.planChange.title') }}: {{ planChangeFor.tenant.name }}</h2>
        <p class="sub">{{ t('ops.planChange.hint', { from: planName(planChangeFor.tenant.plan), to: planName(planChangeFor.toPlanCode) }) }}</p>
        <label class="field"><span>{{ t('ops.billing.period') }}</span>
          <select v-model="planChangeForm.billingPeriod"><option value="month">{{ t('ops.billing.periodOf.month') }}</option><option value="year">{{ t('ops.billing.periodOf.year') }}</option></select>
        </label>
        <label class="field"><span>{{ t('ops.confirm.reason') }}</span><input v-model="planChangeForm.comment" maxlength="500" placeholder="10–500"></label>
        <p v-if="error" class="error">{{ error }}</p>
        <div class="actions"><button type="button" class="chip" @click="planChangeFor = null">{{ t('common.cancel') }}</button><button type="button" class="primary" :disabled="planChangeForm.comment.trim().length < 10 || busy" @click="submitPlanChange">{{ t('ops.planChange.ok') }}</button></div>
      </div>
    </div>

    <div v-if="tfFor" class="modal-backdrop" @click.self="tfFor = null" @keydown.esc="tfFor = null">
      <div class="modal" role="dialog" aria-modal="true" :aria-label="t('ops.tf.title')">
        <h2>{{ t('ops.tf.title') }}: {{ tfFor.name }}</h2>
        <p class="sub">{{ t('ops.tf.text') }}</p>
        <label class="field"><span>{{ t('ops.pickUser') }}</span><select v-model="tfForm.userId"><option value="" disabled>{{ t('ops.pickUser') }}</option><option v-for="u in impUsers.filter(x => x.twoFactor)" :key="u.id" :value="u.id">{{ u.fullName }} · {{ u.phone }}</option></select></label>
        <p v-if="!impUsers.some(x => x.twoFactor)" class="sub">{{ t('ops.tf.nobody') }}</p>
        <label class="field"><span>{{ t('ops.reasonHint') }}</span><input v-model="tfForm.reason" maxlength="500" placeholder="10–500"></label>
        <p v-if="error" class="error">{{ error }}</p>
        <div class="actions"><button type="button" class="chip" @click="tfFor = null">{{ t('common.cancel') }}</button><button type="button" class="danger" :disabled="!tfForm.userId || tfForm.reason.trim().length < 10 || busy" @click="resetTwoFactor">{{ t('ops.tf.reset') }}</button></div>
      </div>
    </div>

    <div v-if="impFor" class="modal-backdrop" @click.self="impFor = null" @keydown.esc="impFor = null">
      <div class="modal" role="dialog" aria-modal="true" :aria-label="t('ops.impersonate')">
        <h2>{{ t('ops.impersonate') }}: {{ impFor.name }}</h2>
        <label class="field"><span>{{ t('ops.pickUser') }}</span><select v-model="impForm.userId"><option value="" disabled>{{ t('ops.pickUser') }}</option><option v-for="u in impUsers.filter(x => x.status === 'active')" :key="u.id" :value="u.id">{{ u.fullName }} · {{ u.phone }}</option></select></label>
        <label class="field"><span>{{ t('ops.reasonHint') }}</span><input v-model="impForm.reason" maxlength="500"></label>
        <p class="sub">{{ t('ops.impWarn') }}</p>
        <div class="actions"><button type="button" class="chip" @click="impFor = null">{{ t('common.cancel') }}</button><button type="button" class="primary" :disabled="!impForm.userId || impForm.reason.length < 10" @click="impersonate">{{ t('ops.enter') }}</button></div>
      </div>
    </div>
  </div>
</template>

<style scoped>
/* Мокап PlatformTenants: беж фон, карточки-строки, бирюза = активный, солнце = тріал, коралл = призупинено */
.ops { min-height: 100dvh; background: var(--color-bg); color: var(--color-ink); font-family: var(--font-family); }
.top { display: flex; align-items: center; justify-content: space-between; gap: var(--space-3); padding: var(--space-3) var(--space-5); background: var(--color-bg-soft); border-bottom: 2px solid var(--color-bg-line); }
.brand { display: flex; align-items: center; gap: var(--space-2); font-weight: 900; }
.dots { display: inline-flex; gap: 3px; }
.dots i { width: 12px; height: 12px; border-radius: 4px 2px 2px 2px; display: inline-block; }
.dots .sun { background: var(--color-sun); }
.dots .teal { background: var(--color-teal); border-radius: 2px 4px 2px 2px; }
.dots .coral { background: var(--color-coral); border-radius: 2px 2px 2px 4px; }
.dots .ink { background: var(--color-ink); border-radius: 2px 2px 4px 2px; }
.who { display: flex; gap: var(--space-3); align-items: center; font-size: var(--font-size-body-s); color: var(--color-ink-muted); }
.login { max-width: 360px; margin: 15vh auto; display: grid; gap: var(--space-3); padding: var(--space-4); }
.body { padding: var(--space-5) var(--space-4); display: grid; gap: var(--space-4); max-width: 1400px; margin: 0 auto; }
.head { display: flex; align-items: flex-end; justify-content: space-between; gap: var(--space-4); flex-wrap: wrap; }
.head h1 { margin: 0; font-size: 27px; font-weight: 900; letter-spacing: -0.02em; }
.eyebrow, .hint { font-size: var(--font-size-body-s); font-weight: 700; color: var(--color-ink-muted); }
.hint { margin: 0; }
.field { display: grid; gap: var(--space-1); font-size: var(--font-size-body-s); font-weight: 700; color: var(--color-ink-muted); }
.field.end { align-self: end; }
.field em { font-style: normal; font-weight: 600; }
input, select { font: inherit; border: 2px solid var(--color-bg-line); border-radius: var(--radius-s); padding: var(--space-2) var(--space-3); background: var(--color-bg-soft); color: var(--color-ink); min-height: 44px; width: 100%; }
input:focus-visible, select:focus-visible, button:focus-visible { outline: 3px solid var(--color-sun); outline-offset: 2px; }
.phone { display: flex; align-items: center; gap: var(--space-1); border: 2px solid var(--color-bg-line); border-radius: var(--radius-s); padding: 0 var(--space-3); background: var(--color-bg-soft); }
.phone input { border: none; background: none; flex: 1; padding-left: 0; }
.kpis { display: flex; gap: var(--space-2); flex-wrap: wrap; }
.kpi { background: var(--color-bg-soft); border-radius: var(--radius-m); padding: var(--space-2) var(--space-3); display: grid; text-align: center; min-width: 96px; flex: 1; }
.kpi b { font-size: var(--font-size-title-l); font-weight: 900; color: var(--color-teal-ink); }
.kpi.coral b { color: var(--color-coral-ink); }
.kpi span { font-size: var(--font-size-body-s); color: var(--color-ink-muted); }
.table-wrap { overflow-x: auto; }
.table { width: 100%; border-collapse: separate; border-spacing: 0 6px; }
th { text-align: left; font-size: 12px; font-weight: 900; letter-spacing: 0.05em; color: var(--color-ink-muted); padding: 0 var(--space-3) var(--space-2); }
td { padding: var(--space-3); background: var(--color-bg-soft); vertical-align: middle; font-size: 14px; line-height: 20px; }
.row td:first-child { border-radius: var(--radius-s) 0 0 var(--radius-s); }
.row td:last-child { border-radius: 0 var(--radius-s) var(--radius-s) 0; }
.acts { display: flex; gap: var(--space-1); flex-wrap: wrap; }
.chip { font: inherit; font-size: var(--font-size-body-s); font-weight: 700; border: 2px solid var(--color-bg-line); background: var(--color-bg-soft); color: var(--color-ink); border-radius: var(--radius-pill); padding: var(--space-1) var(--space-3); cursor: pointer; min-height: 32px; }
.chip.warn { border-color: var(--color-coral); color: var(--color-coral-ink); }
.primary, .danger { font: inherit; font-weight: 800; border: none; background: var(--color-sun); color: var(--color-ink); border-radius: var(--radius-s); padding: var(--space-2) var(--space-4); cursor: pointer; min-height: 44px; }
.danger { background: var(--color-coral); color: var(--color-coral-deep); }
.primary:disabled, .danger:disabled { opacity: 0.4; cursor: not-allowed; }
.link { font: inherit; background: none; border: none; padding: 0; color: inherit; cursor: pointer; text-decoration: underline dotted; }
.star { color: var(--color-coral-ink); font-weight: 900; }
.badge { display: inline-block; padding: 4px 10px; border-radius: var(--radius-pill); background: var(--color-bg); color: var(--color-ink-muted); font-size: 12px; font-weight: 600; line-height: 16px; white-space: nowrap; }
.badge.active, .badge.plan.network, .badge.plan.custom { background: var(--color-teal); color: var(--color-ink); }
.badge.trial { background: var(--color-sun); color: var(--color-ink); }
.badge.suspended, .badge.archived { background: var(--color-coral); color: var(--color-coral-deep); }
select.badge { width: auto; min-height: 0; border: none; padding-right: 22px; appearance: auto; }
.card { background: var(--color-bg-soft); border-radius: var(--radius-l); padding: var(--space-4); display: grid; gap: var(--space-3); }
.card h2, .modal h2 { margin: 0; font-weight: 800; font-size: var(--font-size-title-l); }
.grid { display: grid; grid-template-columns: repeat(auto-fit, minmax(200px, 1fr)); gap: var(--space-3); }
.grid.two { grid-template-columns: repeat(auto-fit, minmax(140px, 1fr)); }
.coral { color: var(--color-coral-ink); font-weight: 700; }
.sub { font-size: 12px; color: var(--color-ink-muted); font-weight: 700; margin: 0; }
.error { color: var(--color-coral-ink); padding: var(--space-2) var(--space-5); margin: 0; font-weight: 700; }
.notice { color: var(--color-teal-ink); padding: var(--space-2) var(--space-5); margin: 0; font-weight: 700; }
.modal-backdrop { position: fixed; inset: 0; background: rgb(12 15 20 / 55%); display: grid; place-items: center; padding: var(--space-4); z-index: 10; }
.modal { background: var(--color-bg-soft); border-radius: var(--radius-xl); padding: var(--space-5); width: min(520px, 100%); display: grid; gap: var(--space-3); max-height: 90dvh; overflow: auto; }
.modal.wide { width: min(720px, 100%); }
.modal h3 { margin: var(--space-2) 0 0; font-size: var(--font-size-body); font-weight: 800; }
.kv { display: grid; grid-template-columns: auto 1fr; gap: var(--space-1) var(--space-3); margin: 0; }
.kv dt { color: var(--color-ink-muted); font-weight: 700; }
.kv dd { margin: 0; font-weight: 800; }
.payments { list-style: none; margin: 0; padding: 0; display: grid; gap: var(--space-2); }
.payment { display: flex; gap: var(--space-2); align-items: center; flex-wrap: wrap; background: var(--color-bg); border-radius: var(--radius-s); padding: var(--space-2) var(--space-3); }
.badge.paid, .badge.applied { background: var(--color-teal); color: var(--color-ink); }
.badge.failed, .badge.refunded { background: var(--color-coral); color: var(--color-coral-deep); }
.badge.pending, .badge.written_off, .badge.grace { background: var(--color-sun); color: var(--color-ink); }
.badge.readonly, .badge.blocked { background: var(--color-coral); color: var(--color-coral-deep); }
.actions { display: flex; justify-content: flex-end; gap: var(--space-2); flex-wrap: wrap; }
.sr-only { position: absolute; width: 1px; height: 1px; overflow: hidden; clip: rect(0 0 0 0); }
.area { font: inherit; border: 2px solid var(--color-bg-line); border-radius: var(--radius-s); padding: var(--space-2) var(--space-3); background: var(--color-bg-soft); color: var(--color-ink); width: 100%; resize: vertical; }
.picks { border: none; margin: 0; padding: 0; display: flex; flex-wrap: wrap; gap: var(--space-2) var(--space-4); }
.pick { display: inline-flex; align-items: center; gap: var(--space-2); font-size: var(--font-size-body-s); font-weight: 700; }
.pick input { width: auto; min-height: 0; }
@media (max-width: 720px) {
  .table thead { display: none; }
  .table, .table tbody, .row { display: block; }
  .row { background: var(--color-bg-soft); border-radius: var(--radius-s); margin-bottom: var(--space-2); padding: var(--space-2); }
  .row td { display: block; border-radius: 0 !important; padding: var(--space-1) var(--space-2); }
  .row td[data-label]:not([data-label='tenant'])::before { content: attr(data-label) ': '; font-size: 12px; color: var(--color-ink-muted); font-weight: 700; }
}
</style>
