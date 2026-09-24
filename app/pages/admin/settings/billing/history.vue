<script setup lang="ts">
/**
 * «Історія платежів» (docs/v2/35-billing-limits.md §5.3, §9) — тільки `owner`
 * (`billing.payments.view`, `35` §2: суми бачить лише він). Файл рахунку (`invoice_media_id`)
 * у цьому PR ніхто не завантажує (приймання платежу — ручне, без інтерфейсу завантаження) —
 * колонка «Рахунок» показує номер рахунку текстом, а не посилання на файл.
 */
definePageMeta({ layout: 'admin', middleware: 'admin-scope', requiredScope: 'billing.payments.view' })
const { t, locale } = useI18n()
const { api } = useApi()

interface Payment {
  id: string, kind: 'subscription' | 'addon' | 'adjustment', planCode: string | null, addonCode: string | null
  billingPeriod: string | null, periodFrom: string | null, periodTo: string | null, amountMinor: number, currency: string
  status: string, method: string | null, invoiceNumber: string | null, comment: string | null, createdAt: string
}

const items = ref<Payment[]>([])
const nextCursor = ref<string | null>(null)
const error = ref('')
const loading = ref(true)
const filters = reactive({ from: '', to: '', kind: '', status: '' })

async function load(reset = true) {
  error.value = ''
  if (reset) { loading.value = true; items.value = [] }
  try {
    const q: Record<string, string> = {}
    if (filters.from) q.from = filters.from
    if (filters.to) q.to = filters.to
    if (filters.kind) q.kind = filters.kind
    if (filters.status) q.status = filters.status
    if (!reset && nextCursor.value) q.cursor = nextCursor.value
    const page = await api<{ items: Payment[], nextCursor: string | null }>('/billing/payments', { query: q })
    items.value = reset ? page.items : [...items.value, ...page.items]
    nextCursor.value = page.nextCursor
  }
  catch (err) { error.value = apiErrorOf(err).message }
  finally { loading.value = false }
}
onMounted(() => load())

const fmtDate = (s: string | null) => s ? new Date(s).toLocaleDateString(locale.value, { day: '2-digit', month: '2-digit', year: 'numeric' }) : '—'
const money = (minor: number, currency: string) => `${(minor / 100).toLocaleString(locale.value, { minimumFractionDigits: 2, maximumFractionDigits: 2 })} ${currency}`
const purpose = (p: Payment) => (p.kind === 'subscription' ? t('billing.history.purposeSubscription', { plan: p.planCode ?? '' }) : p.kind === 'addon' ? t('billing.history.purposeAddon', { addon: p.addonCode ?? '' }) : t('billing.history.purposeAdjustment'))
const period = (p: Payment) => (p.periodFrom && p.periodTo ? `${fmtDate(p.periodFrom)} — ${fmtDate(p.periodTo)}` : '—')
</script>

<template>
  <div>
    <PageHeader :title="t('billing.history.title')" :crumbs="[{ label: t('admin.section.settings') }, { label: t('billing.screen.title'), to: '/admin/settings/billing' }, { label: t('billing.history.title') }]" />

    <div class="filters">
      <label class="field"><span>{{ t('billing.history.from') }}</span><input v-model="filters.from" type="date"></label>
      <label class="field"><span>{{ t('billing.history.to') }}</span><input v-model="filters.to" type="date"></label>
      <label class="field"><span>{{ t('billing.history.kind') }}</span>
        <select v-model="filters.kind">
          <option value="">{{ t('billing.history.anyKind') }}</option>
          <option value="subscription">{{ t('billing.history.kindOf.subscription') }}</option>
          <option value="addon">{{ t('billing.history.kindOf.addon') }}</option>
          <option value="adjustment">{{ t('billing.history.kindOf.adjustment') }}</option>
        </select>
      </label>
      <label class="field"><span>{{ t('billing.history.status') }}</span>
        <select v-model="filters.status">
          <option value="">{{ t('billing.history.anyStatus') }}</option>
          <option v-for="s in ['pending', 'paid', 'failed', 'refunded', 'written_off']" :key="s" :value="s">{{ t(`billing.history.statusOf.${s}`) }}</option>
        </select>
      </label>
      <button type="button" class="btn ghost" @click="load()">{{ t('billing.history.apply') }}</button>
    </div>

    <p v-if="error" class="error-text" role="alert">{{ error }}</p>
    <p v-else-if="!loading && !items.length" class="help">{{ t('billing.history.empty') }}</p>

    <div v-if="items.length" class="table-wrap">
      <table class="table">
        <thead>
          <tr>
            <th>{{ t('billing.history.col.date') }}</th>
            <th>{{ t('billing.history.col.purpose') }}</th>
            <th>{{ t('billing.history.col.period') }}</th>
            <th>{{ t('billing.history.col.amount') }}</th>
            <th>{{ t('billing.history.col.status') }}</th>
            <th>{{ t('billing.history.col.invoice') }}</th>
          </tr>
        </thead>
        <tbody>
          <tr v-for="p in items" :key="p.id">
            <td>{{ fmtDate(p.createdAt) }}</td>
            <td>{{ purpose(p) }}</td>
            <td>{{ period(p) }}</td>
            <td>{{ money(p.amountMinor, p.currency) }}</td>
            <td><span :class="['pill', p.status]">{{ t(`billing.history.statusOf.${p.status}`) }}</span></td>
            <td>{{ p.invoiceNumber ?? '—' }}</td>
          </tr>
        </tbody>
      </table>
    </div>

    <button v-if="nextCursor" type="button" class="btn ghost" @click="load(false)">{{ t('common.loadMore') }}</button>
  </div>
</template>

<style scoped>
.filters { display: flex; gap: var(--space-3); flex-wrap: wrap; align-items: end; margin-bottom: var(--space-4); }
.field { display: grid; gap: var(--space-1); font-size: var(--font-size-body-s); font-weight: 700; color: var(--color-ink-muted); }
.table-wrap { overflow-x: auto; margin-bottom: var(--space-3); }
.table { width: 100%; border-collapse: collapse; }
.table th { text-align: left; font-size: 12px; font-weight: 900; color: var(--color-ink-muted); padding: 0 var(--space-3) var(--space-2); }
.table td { padding: var(--space-2) var(--space-3); border-top: 1px solid var(--color-bg-line-soft); }
.pill { display: inline-block; padding: 2px 10px; border-radius: var(--radius-pill); font-size: 12px; font-weight: 800; background: var(--color-bg-line-soft); }
.pill.paid { background: var(--color-teal); color: var(--color-ink); }
.pill.failed, .pill.refunded { background: var(--color-coral); color: var(--color-coral-deep); }
.pill.pending, .pill.written_off { background: var(--color-sun); color: var(--color-ink); }
</style>
