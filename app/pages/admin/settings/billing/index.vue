<script setup lang="ts">
/**
 * «Тариф і ліміти» (docs/v2/35-billing-limits.md §5.1) — витрина підписки: тариф, ціна (лише
 * `owner`), дата оплати, блок ШІ, докупені опції, посилання на історію платежів. Лічильники за
 * осями — на `/admin/settings/usage` (PR-09); тут — компактна плитка з тим самим числом,
 * а не другим підрахунком (docs/v2/44 В-5).
 *
 * Самообслуговування («Продовжити тариф», «Змінити тариф») в цьому PR не працює як форма —
 * платіжний провайдер не підключений (`44` §8, `HANDOFF` §6): кнопки ведуть на підказку
 * звернутися до менеджера, який приймає платіж вручну (`POST /platform/tenants/:id/payments`).
 * Повноцінний self-service (preflight/blocked, екран §5.2, форма §6.1) — окремий PR
 * (`docs/v2/46-progress.md`).
 */
definePageMeta({ layout: 'admin', middleware: 'admin-scope', requiredScope: 'billing.view' })
const { t, locale } = useI18n()
const { api } = useApi()
const { hasScope } = useAuth()

interface AiBlock { status: 'active' | 'expired' | 'off', until: string | null, termDays: number | null, included: boolean }
interface Addon { addonCode: string, name: string, axis: string, qty: number, unitStep: number, validUntil: string | null }
interface Subscription { billingPeriod: 'month' | 'year', status: string, paidUntil: string | null, graceUntil: string | null, aiUntil: string | null, autorenew: boolean, currency: string, aiStatus: string }
interface Summary {
  plan: { code: string, name: string, titleUk: string | null, tier: number }
  priceMinor: number | null
  currency: string
  subscription: Subscription
  ai: AiBlock
  addons: Addon[]
}

const summary = ref<Summary | null>(null)
const error = ref('')
const loading = ref(true)
const showContactHint = ref(false)

async function load() {
  loading.value = true
  error.value = ''
  try { summary.value = await api<Summary>('/billing/summary') }
  catch (err) { error.value = apiErrorOf(err).message }
  finally { loading.value = false }
}
onMounted(load)

const fmtDate = (s: string | null) => s ? new Date(s).toLocaleDateString(locale.value, { day: '2-digit', month: '2-digit', year: 'numeric' }) : '—'
const daysLeft = (s: string | null) => s ? Math.ceil((new Date(`${s}T00:00:00`).getTime() - Date.now()) / 86_400_000) : null
const money = (minor: number, currency: string) => `${(minor / 100).toLocaleString(locale.value, { minimumFractionDigits: 2, maximumFractionDigits: 2 })} ${currency}`
const statusTone = (s: string) => (s === 'active' ? 'teal' : s === 'grace' ? 'sun' : s === 'trial' ? 'sun' : 'coral')
</script>

<template>
  <div>
    <PageHeader :title="t('billing.screen.title')" :crumbs="[{ label: t('admin.section.settings') }, { label: t('billing.screen.title') }]" />

    <div v-if="loading" class="skeletons">
      <div v-for="i in 3" :key="i" class="skeleton" />
    </div>

    <template v-else-if="error">
      <p class="error-text" role="alert">{{ t('billing.screen.loadError') }}</p>
      <button type="button" class="btn ghost" @click="load">{{ t('billing.screen.retry') }}</button>
    </template>

    <template v-else-if="summary">
      <p v-if="summary.subscription.status === 'trial'" class="note sun">
        {{ t('billing.screen.trialNotice', { date: fmtDate(summary.subscription.paidUntil) }) }}
      </p>
      <p v-if="summary.subscription.status === 'grace'" class="note sun">
        {{ t('billing.screen.graceNotice', { date: fmtDate(summary.subscription.graceUntil), days: daysLeft(summary.subscription.graceUntil) }) }}
      </p>
      <p v-if="summary.subscription.status === 'readonly'" class="note coral">{{ t('billing.screen.readonlyNotice') }}</p>

      <section class="card">
        <div class="card-head">
          <h2 class="panel-title">{{ t('billing.screen.currentPlan') }}</h2>
          <span :class="['pill', statusTone(summary.subscription.status)]">{{ t(`billing.status.${summary.subscription.status}`) }}</span>
        </div>
        <p class="plan-name">{{ summary.plan.titleUk ?? summary.plan.name }}</p>
        <p v-if="summary.priceMinor !== null" class="price">{{ money(summary.priceMinor, summary.currency) }} / {{ t(`billing.period.${summary.subscription.billingPeriod}`) }}</p>
        <dl class="kv">
          <dt>{{ t('billing.screen.billingPeriod') }}</dt><dd>{{ t(`billing.period.${summary.subscription.billingPeriod}`) }}</dd>
          <dt>{{ t('billing.screen.paidUntil') }}</dt>
          <dd>{{ fmtDate(summary.subscription.paidUntil) }}<span v-if="daysLeft(summary.subscription.paidUntil) !== null" class="sub"> · {{ t('billing.screen.daysLeft', { n: daysLeft(summary.subscription.paidUntil) }) }}</span></dd>
        </dl>
        <div class="actions">
          <button type="button" class="btn primary" @click="showContactHint = true">{{ t('billing.screen.extend') }}</button>
          <button v-if="hasScope('billing.manage')" type="button" class="btn ghost" @click="showContactHint = true">{{ t('billing.screen.change') }}</button>
        </div>
        <p v-if="showContactHint" class="note teal">{{ t('billing.screen.contactManager') }}</p>
      </section>

      <section class="card">
        <h2 class="panel-title">{{ t('billing.screen.aiBlock') }}</h2>
        <p v-if="summary.ai.status === 'expired'" class="note coral">{{ t('billing.screen.aiExpiredNotice', { date: fmtDate(summary.ai.until) }) }}</p>
        <dl class="kv">
          <dt>{{ t('billing.screen.aiUntil') }}</dt>
          <dd>{{ fmtDate(summary.ai.until) }}<span v-if="daysLeft(summary.ai.until) !== null" class="sub"> · {{ t('billing.screen.daysLeft', { n: daysLeft(summary.ai.until) }) }}</span></dd>
        </dl>
        <div class="actions"><button v-if="hasScope('billing.manage')" type="button" class="btn ghost" @click="showContactHint = true">{{ t('billing.screen.extendAi') }}</button></div>
      </section>

      <section class="card">
        <h2 class="panel-title">{{ t('billing.screen.addonsBlock') }}</h2>
        <p v-if="!summary.addons.length" class="help">{{ t('billing.screen.addonsEmpty') }}</p>
        <ul v-else class="addons">
          <li v-for="a in summary.addons" :key="a.addonCode" class="addon">
            <span>{{ a.name }}</span>
            <span class="sub">{{ t(`billing.axis.${a.axis}`) }} · ×{{ a.qty }}<template v-if="a.validUntil"> · {{ t('billing.screen.until', { date: fmtDate(a.validUntil) }) }}</template></span>
          </li>
        </ul>
        <div v-if="hasScope('billing.manage')" class="actions"><button type="button" class="btn ghost" @click="showContactHint = true">{{ t('billing.screen.buyAddon') }}</button></div>
      </section>

      <p v-if="hasScope('billing.payments.view')" class="history-link">
        <NuxtLink to="/admin/settings/billing/history">{{ t('billing.screen.historyLink') }}</NuxtLink>
      </p>
    </template>
  </div>
</template>

<style scoped>
.skeletons { display: grid; gap: var(--space-3); }
.skeleton { height: 120px; border-radius: var(--radius-l); background: var(--color-bg-line-soft); animation: pulse 1.4s ease-in-out infinite; }
@keyframes pulse { 0%, 100% { opacity: 0.6; } 50% { opacity: 1; } }
.card { margin-bottom: var(--space-4); }
.card-head { display: flex; align-items: center; justify-content: space-between; gap: var(--space-3); }
.plan-name { font-size: var(--font-size-title-l); font-weight: 900; margin: var(--space-2) 0 0; }
.price { font-weight: 800; color: var(--color-ink-muted); margin: var(--space-1) 0 0; }
.pill { display: inline-block; padding: 2px 10px; border-radius: var(--radius-pill); font-size: 12px; font-weight: 800; background: var(--color-bg-line-soft); }
.pill.teal { background: var(--color-teal); color: var(--color-ink); }
.pill.sun { background: var(--color-sun); color: var(--color-ink); }
.pill.coral { background: var(--color-coral); color: var(--color-coral-deep); }
.kv { display: grid; grid-template-columns: auto 1fr; gap: var(--space-1) var(--space-3); margin: var(--space-3) 0; }
.kv dt { color: var(--color-ink-muted); font-weight: 700; }
.kv dd { margin: 0; font-weight: 800; }
.actions { display: flex; gap: var(--space-2); flex-wrap: wrap; margin-top: var(--space-2); }
.addons { list-style: none; margin: 0; padding: 0; display: grid; gap: var(--space-2); }
.addon { display: flex; flex-direction: column; gap: 2px; background: var(--color-bg-soft); border-radius: var(--radius-s); padding: var(--space-2) var(--space-3); }
.history-link { margin-top: var(--space-3); }
.sub { color: var(--color-ink-muted); font-weight: 600; }
</style>
