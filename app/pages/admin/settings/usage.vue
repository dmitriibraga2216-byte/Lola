<script setup lang="ts">
/**
 * Статистика використання (мокап TenantStats, docs/24 §4.4.1): плитки «Активні · Диск · SMS» с лимитами тарифа,
 * «Що не входить у ліміт» (заблоковані, архівні), «Останній збір», тариф. Всё считает сервер раз в сутки.
 */
definePageMeta({ layout: 'admin', middleware: 'admin-scope', requiredScope: 'settings.tenant' })
const { t } = useI18n()
const { api } = useApi()

interface Snap { collectedAt: string, activeUsers: number, blockedUsers: number, archivedUsers: number, storageBytes: number, smsMonth: number, coursesCount: number, assignmentsCount: number, attemptsMonth: number }
/** Потребление по оси: считает сервер (docs/v2/35 §7.1, §7.3) — экран только показывает. */
interface AxisUsage {
  axis: string
  used: number
  limit: number | null
  pct: number | null
  kind: 'hard' | 'hard_degraded' | 'soft'
  source: 'live' | 'counter'
  level: 'ok' | 'warn' | 'exceeded'
  degradation: string | null
  periodStart: string
  periodEnd: string
}
interface View { last: Snap | null, plan: { code: string, name: string } | null, limits: { users: number | null, storageGb: number | null, smsPerMonth: number | null }, consumption: AxisUsage[], history: { collectedAt: string, activeUsers: number, storageBytes: number }[] }
const view = ref<View | null>(null)
const error = ref('')
onMounted(async () => { try { view.value = await api<View>('/settings/usage') } catch (err) { error.value = apiErrorOf(err).message } })

const GIB = 1024 ** 3
const gb = (b: number) => (b / GIB).toLocaleString('uk-UA', { maximumFractionDigits: 1 })
const pct = (v: number, lim: number | null) => (lim ? Math.min(100, Math.round(v / lim * 100)) : 0)
const tone = (v: number, lim: number | null) => (lim && v >= lim ? 'coral' : lim && v / lim >= 0.8 ? 'sun' : 'teal')
const fmt = (s: string) => new Date(s).toLocaleString('uk-UA', { day: '2-digit', month: '2-digit', year: 'numeric', hour: '2-digit', minute: '2-digit' })
const day = (s: string) => new Date(s).toLocaleDateString('uk-UA', { day: '2-digit', month: '2-digit', year: 'numeric' })
/** Значение в единице оси: хранилище — в ГБ для читабельности, остальные — счётчиками. */
const amount = (a: AxisUsage, n: number | null) => (n === null ? t('billing.unlimited') : a.axis === 'storage_bytes' ? `${gb(n)} ${t('settings.usage.gb')}` : String(n))
const axisTone = (a: AxisUsage) => (a.level === 'exceeded' ? 'coral' : a.level === 'warn' ? 'sun' : 'teal')
</script>

<template>
  <div>
    <PageHeader :title="t('settings.usage.title')" :crumbs="[{ label: t('admin.section.settings') }, { label: t('settings.usage.title') }]" />
    <p v-if="error" class="error-text" role="alert">{{ error }}</p>
    <p v-else-if="view && !view.last" class="note sun">{{ t('settings.usage.notCollected') }}</p>

    <template v-if="view?.last">
      <div class="tiles">
        <div class="tile" :class="tone(view.last.activeUsers, view.limits.users)">
          <span>{{ t('settings.usage.activeUsers') }}</span>
          <b>{{ view.last.activeUsers }}<small v-if="view.limits.users"> {{ t('settings.usage.of', { n: view.limits.users }) }}</small></b>
          <div v-if="view.limits.users" class="bar" role="progressbar" :aria-valuenow="pct(view.last.activeUsers, view.limits.users)" aria-valuemin="0" aria-valuemax="100"><i :style="{ width: `${pct(view.last.activeUsers, view.limits.users)}%` }" /></div>
        </div>
        <div class="tile" :class="tone(view.last.storageBytes / 1024 ** 3, view.limits.storageGb)">
          <span>{{ t('settings.usage.storage') }}</span>
          <b>{{ gb(view.last.storageBytes) }} {{ t('settings.usage.gb') }}<small v-if="view.limits.storageGb"> {{ t('settings.usage.of', { n: `${view.limits.storageGb} ${t('settings.usage.gb')}` }) }}</small></b>
          <div v-if="view.limits.storageGb" class="bar" role="progressbar" :aria-valuenow="pct(view.last.storageBytes / 1024 ** 3, view.limits.storageGb)" aria-valuemin="0" aria-valuemax="100"><i :style="{ width: `${pct(view.last.storageBytes / 1024 ** 3, view.limits.storageGb)}%` }" /></div>
        </div>
        <div class="tile" :class="tone(view.last.smsMonth, view.limits.smsPerMonth)">
          <span>{{ t('settings.usage.smsMonth') }}</span>
          <b>{{ view.last.smsMonth }}<small v-if="view.limits.smsPerMonth"> {{ t('settings.usage.of', { n: view.limits.smsPerMonth }) }}</small></b>
          <div v-if="view.limits.smsPerMonth" class="bar" role="progressbar" :aria-valuenow="pct(view.last.smsMonth, view.limits.smsPerMonth)" aria-valuemin="0" aria-valuemax="100"><i :style="{ width: `${pct(view.last.smsMonth, view.limits.smsPerMonth)}%` }" /></div>
        </div>
      </div>

      <section v-if="view.consumption?.length" class="card axes">
        <h2 class="panel-title">{{ t('billing.usage.title') }}</h2>
        <p class="help">{{ t('billing.usage.period', { from: day(view.consumption[0]!.periodStart), to: day(view.consumption[0]!.periodEnd) }) }}</p>
        <ul class="axis-list">
          <li v-for="a in view.consumption" :key="a.axis" class="axis" :class="axisTone(a)">
            <div class="axis-head">
              <span class="axis-name">{{ t(`billing.axis.${a.axis}`) }}</span>
              <span class="axis-val">
                {{ amount(a, a.used) }}<template v-if="a.limit !== null"> {{ t('settings.usage.of', { n: amount(a, a.limit) }) }}</template>
                <template v-else> · {{ t('billing.unlimited') }}</template>
              </span>
            </div>
            <div v-if="a.limit !== null" class="bar" role="progressbar" :aria-valuenow="pct(a.used, a.limit)" aria-valuemin="0" aria-valuemax="100"><i :style="{ width: `${pct(a.used, a.limit)}%` }" /></div>
            <p class="axis-note">
              <span>{{ a.source === 'live' ? t('billing.usage.live') : t('billing.usage.counter') }}</span>
              <span v-if="a.kind === 'soft'"> · {{ t('billing.usage.soft') }}</span>
              <span v-if="a.degradation"> · {{ t(`billing.degradation.${a.degradation}`) }}</span>
            </p>
          </li>
        </ul>
      </section>

      <div class="grid">
        <section class="card">
          <h2 class="panel-title">{{ t('settings.usage.notInLimit') }}</h2>
          <dl class="kv">
            <dt>{{ t('settings.usage.blocked') }}</dt><dd>{{ view.last.blockedUsers }}</dd>
            <dt>{{ t('settings.usage.archived') }}</dt><dd>{{ view.last.archivedUsers }}</dd>
          </dl>
          <p class="help">{{ t('settings.usage.limitRule') }}</p>
        </section>
        <section class="card">
          <h2 class="panel-title">{{ t('settings.usage.collection') }}</h2>
          <p class="help">{{ t('settings.usage.collectionHint') }}</p>
          <dl class="kv">
            <dt>{{ t('settings.usage.lastCollected') }}</dt><dd>{{ fmt(view.last.collectedAt) }}</dd>
            <dt>{{ t('settings.usage.plan') }}</dt><dd>{{ view.plan?.name ?? '—' }}</dd>
            <dt>{{ t('settings.usage.courses') }}</dt><dd>{{ view.last.coursesCount }}</dd>
            <dt>{{ t('settings.usage.assignments') }}</dt><dd>{{ view.last.assignmentsCount }}</dd>
            <dt>{{ t('settings.usage.attemptsMonth') }}</dt><dd>{{ view.last.attemptsMonth }}</dd>
          </dl>
        </section>
      </div>
    </template>
  </div>
</template>

<style scoped>
.tile small { font-size: var(--font-size-body-s); font-weight: 700; color: var(--color-ink-muted); }
.bar { height: 6px; border-radius: var(--radius-pill); background: var(--color-bg-line-soft); margin-top: var(--space-2); overflow: hidden; }
.bar i { display: block; height: 100%; background: var(--color-teal); }
.tile.sun .bar i { background: var(--color-sun); }
.tile.coral .bar i { background: var(--color-coral); }
.axes { margin-top: var(--space-4); }
.axis-list { list-style: none; margin: var(--space-3) 0 0; padding: 0; display: grid; gap: var(--space-3); }
.axis-head { display: flex; justify-content: space-between; align-items: baseline; gap: var(--space-3); flex-wrap: wrap; }
.axis-name { font-weight: 700; }
.axis-val { font-weight: 800; }
.axis-note { margin: var(--space-1) 0 0; font-size: 12px; font-weight: 700; color: var(--color-ink-muted); }
.axis.sun .axis-val { color: var(--color-sun-ink); }
.axis.coral .axis-val { color: var(--color-coral-ink); }
.axis.sun .bar i { background: var(--color-sun); }
.axis.coral .bar i { background: var(--color-coral); }
.grid { display: grid; grid-template-columns: repeat(auto-fit, minmax(280px, 1fr)); gap: var(--space-4); margin-top: var(--space-4); }
.kv { display: grid; grid-template-columns: 1fr auto; gap: var(--space-1) var(--space-3); margin: 0; }
.kv dt { color: var(--color-ink-muted); }
.kv dd { margin: 0; font-weight: 800; text-align: right; }
</style>
