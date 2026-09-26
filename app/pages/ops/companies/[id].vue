<script setup lang="ts">
/**
 * Карточка компании → «Огляд» (docs/24 §4.2, docs/25 §7 п. 4): статус, тариф, потребление по осям
 * (те же счётчики, по которым операция блокируется), последние действия операторов. Агрегаты, не
 * содержимое. Остальные вкладки и действия — следующий PR; до тех пор — прежняя панель `/ops`.
 */
definePageMeta({ layout: 'ops', middleware: 'ops-auth' })
const { t } = useI18n()
const { formatShortDate } = useFormat()
const { ops } = useOps()
const route = useRoute()

interface Overview {
  tenant: { id: string, slug: string, name: string, status: string, plan: string, trialEndsAt: string | null, createdAt: string, archivedAt: string | null }
  stats: { activeUsers: number, totalUsers: number, wau: number, completed30d: number }
  flags: string[]
  subscription: { status: string, paidUntil: string | null, graceUntil: string | null, aiUntil: string | null, billingPeriod: string } | null
  consumption: { axis: string, used: number, limit: number | null, pct: number | null, level: 'ok' | 'warn' | 'exceeded', source: string }[]
  recent: { id: string, action: string, adminEmail: string, createdAt: string }[]
}
const data = ref<Overview | null>(null)
const error = ref('')

onMounted(async () => {
  try { data.value = await ops<Overview>(`/tenants/${route.params.id}/overview`) }
  catch (err) { error.value = apiErrorOf(err).message }
})

const fmt = (d: string | null) => d ? formatShortDate(new Date(d)) : '—'
const GIB = 1024 ** 3
/** Хранилище — в ГБ, остальные оси — штуками */
const amount = (axis: string, v: number | null) => v == null ? t('opsConsole.overview.unlimited') : axis === 'storage_bytes' ? `${(v / GIB).toFixed(1)} ${t('ops.gb')}` : String(v)
const axisName = (axis: string) => t(`billing.axis.${axis}`)
const bar = (pct: number | null) => `${Math.min(100, Math.round((pct ?? 0) * 100))}%`
</script>

<template>
  <section>
    <NuxtLink to="/ops/companies" class="link back">{{ t('opsConsole.overview.back') }}</NuxtLink>
    <p v-if="error" class="error-text" role="alert">{{ error }}</p>
    <template v-if="data">
      <h1 class="title">{{ data.tenant.name }} <span class="muted slug">{{ data.tenant.slug }}</span></h1>
      <nav class="chips tabs" :aria-label="t('opsConsole.overview.tabs')">
        <span class="chip on" aria-current="page">{{ t('opsConsole.overview.tab') }}</span>
        <span class="chip muted-tab" :title="t('opsConsole.overview.soonHint')">{{ t('opsConsole.overview.soon') }}</span>
      </nav>
      <div class="grid">
        <div class="card">
          <h2>{{ t('opsConsole.overview.state') }}</h2>
          <p><span class="badge" :class="data.tenant.status === 'active' ? 'teal' : 'muted'">{{ t(`opsConsole.status.${data.tenant.status}`) }}</span></p>
          <p v-if="data.flags.length" class="chips">
            <span v-for="f in data.flags" :key="f" class="badge" :class="f === 'limit_near' ? 'sun' : 'coral'">{{ t(`opsConsole.flags.${f}`) }}</span>
          </p>
          <dl>
            <dt>{{ t('opsConsole.companies.plan') }}</dt><dd>{{ data.tenant.plan }}</dd>
            <dt>{{ t('opsConsole.overview.trialEnds') }}</dt><dd>{{ fmt(data.tenant.trialEndsAt) }}</dd>
            <template v-if="data.subscription">
              <dt>{{ t('opsConsole.overview.paidUntil') }}</dt><dd>{{ fmt(data.subscription.paidUntil) }}</dd>
              <dt>{{ t('opsConsole.overview.aiUntil') }}</dt><dd>{{ fmt(data.subscription.aiUntil) }}</dd>
            </template>
            <dt>{{ t('opsConsole.companies.created') }}</dt><dd>{{ fmt(data.tenant.createdAt) }}</dd>
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
    </template>
  </section>
</template>

<style scoped>
.back { display: inline-block; margin-bottom: var(--space-3); }
.title { margin: 0 0 var(--space-3); font-size: var(--font-size-title-l); font-weight: 900; overflow-wrap: anywhere; }
.slug { font-size: var(--font-size-body); font-weight: 700; }
.tabs { margin-bottom: var(--space-4); }
.muted-tab { cursor: default; }
.grid { display: grid; grid-template-columns: repeat(auto-fit, minmax(260px, 1fr)); gap: var(--space-3); margin-bottom: var(--space-3); }
.card { margin-bottom: var(--space-3); }
h2 { margin: 0 0 var(--space-3); font-size: var(--font-size-body); font-weight: 900; }
dl { display: grid; grid-template-columns: auto 1fr; gap: var(--space-1) var(--space-3); margin: 0; }
dt { color: var(--color-ink-muted); }
dd { margin: 0; font-weight: 700; }
.axes, .recent { list-style: none; margin: 0; padding: 0; display: grid; gap: var(--space-3); }
.axis-head { display: flex; justify-content: space-between; flex-wrap: wrap; gap: var(--space-2); }
.meter { height: var(--space-2); background: var(--color-bg-line-soft); border-radius: var(--radius-pill); overflow: hidden; margin-top: var(--space-1); }
.meter span { display: block; height: 100%; background: var(--color-teal); }
.meter span.warn { background: var(--color-sun); }
.meter span.exceeded { background: var(--color-coral); }
.recent li { overflow-wrap: anywhere; }
</style>
