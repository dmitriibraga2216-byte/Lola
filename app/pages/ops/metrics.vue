<script setup lang="ts">
/**
 * Консоль оператора → «Метрики» (docs/24 §4.6, §3.12): активність, обсяг медіа, збої фонових задач.
 * Ті самі показники, що в KPI старої панелі `/ops`, — рахує `platformMetrics()`.
 *
 * Блок «ШІ: лише метрики» (docs/v2/30 §2, `44` Р-AI2.4): затримка, токени, вартість і статуси
 * викликів за тенантом, роллю й моделлю — `GET /platform/ai-metrics`. Змісту викликів, записів і
 * людей оператор не бачить: сервер їх не віддає.
 */
definePageMeta({ layout: 'ops', middleware: 'ops-auth' })
const { t } = useI18n()
const { ops } = useOps()
const { formatNumber } = useFormat()

interface AiRow { tenantId: string, tenantName: string, purpose: string, modelName: string, currency: string, calls: number, failed: number, timeout: number, errorPct: number | null, avgLatencyMs: number | null, p95LatencyMs: number | null, tokensIn: number, tokensOut: number, costMinor: number }
interface AiMetrics { from: string, to: string, rows: AiRow[], totals: { currency: string, calls: number, errors: number, costMinor: number }[] }

const metrics = ref<Record<string, unknown> | null>(null)
const ai = ref<AiMetrics | null>(null)
const error = ref('')
onMounted(async () => {
  try { metrics.value = await ops<Record<string, unknown>>('/metrics') }
  catch (err) { error.value = apiErrorOf(err).message }
  try { ai.value = await ops<AiMetrics>('/ai-metrics') }
  catch (err) { error.value = apiErrorOf(err).message }
})
const KPI_KEYS = ['tenants_active', 'trials_ending', 'users_active', 'dau', 'wau', 'attempts_today', 'notifications_queued', 'notifications_failed_24h', 'webhooks_failed_24h'] as const
const gb = (b: unknown) => (Number(b) / 1024 / 1024 / 1024).toFixed(1)
const money = (minor: number, currency: string) => `${formatNumber(minor / 100, { minimumFractionDigits: 2, maximumFractionDigits: 2 })} ${currency}`
const ms = (v: number | null) => (v === null ? '—' : formatNumber(v))
</script>

<template>
  <section>
    <h1 class="title">{{ t('opsConsole.nav.metrics') }}</h1>
    <p class="help">{{ t('opsConsole.metricsPage.hint') }}</p>
    <p v-if="error" class="error-text" role="alert">{{ error }}</p>
    <div v-if="metrics" class="tiles" data-testid="ops-metrics">
      <div v-for="k in KPI_KEYS" :key="k" class="tile" :class="{ coral: k.includes('failed') && Number(metrics[k]) > 0 }">
        <b>{{ metrics[k] }}</b><span>{{ t(`opsConsole.metricsPage.${k}`) }}</span>
      </div>
      <div class="tile"><b>{{ gb(metrics.media_bytes) }} {{ t('ops.gb') }}</b><span>{{ t('opsConsole.metricsPage.media') }}</span></div>
    </div>

    <template v-if="ai">
      <h2 class="h2">{{ t('opsConsole.metricsPage.aiTitle') }}</h2>
      <p class="help">{{ t('opsConsole.metricsPage.aiHint') }}</p>
      <p v-if="!ai.rows.length" class="help">{{ t('opsConsole.metricsPage.aiEmpty') }}</p>
      <template v-else>
        <div class="tiles" data-testid="ops-ai-totals">
          <div v-for="x in ai.totals" :key="x.currency" class="tile" :class="{ coral: x.errors > 0 }">
            <b>{{ money(x.costMinor, x.currency) }}</b>
            <span>{{ x.calls }} {{ t('opsConsole.metricsPage.aiCalls') }} · {{ x.errors }} {{ t('opsConsole.metricsPage.aiErrors') }}</span>
          </div>
        </div>
        <div class="table-wrap">
          <table class="table" data-testid="ops-ai-metrics">
            <thead>
              <tr>
                <th>{{ t('opsConsole.metricsPage.aiCol.tenant') }}</th>
                <th>{{ t('opsConsole.metricsPage.aiCol.purpose') }}</th>
                <th>{{ t('opsConsole.metricsPage.aiCol.model') }}</th>
                <th class="num">{{ t('opsConsole.metricsPage.aiCol.calls') }}</th>
                <th class="num">{{ t('opsConsole.metricsPage.aiCol.errors') }}</th>
                <th class="num">{{ t('opsConsole.metricsPage.aiCol.latency') }}</th>
                <th class="num">{{ t('opsConsole.metricsPage.aiCol.tokens') }}</th>
                <th class="num">{{ t('opsConsole.metricsPage.aiCol.cost') }}</th>
              </tr>
            </thead>
            <tbody>
              <tr v-for="r in ai.rows" :key="`${r.tenantId}-${r.purpose}-${r.modelName}-${r.currency}`">
                <td>{{ r.tenantName }}</td>
                <td>{{ t(`aiSettings.purpose.${r.purpose}`, r.purpose) }}</td>
                <td>{{ r.modelName }}</td>
                <td class="num">{{ r.calls }}</td>
                <td class="num">{{ r.failed + r.timeout }}<template v-if="r.errorPct !== null"> · {{ formatNumber(r.errorPct, { maximumFractionDigits: 1 }) }} %</template></td>
                <td class="num">{{ ms(r.avgLatencyMs) }} / {{ ms(r.p95LatencyMs) }}</td>
                <td class="num">{{ formatNumber(r.tokensIn) }} / {{ formatNumber(r.tokensOut) }}</td>
                <td class="num">{{ money(r.costMinor, r.currency) }}</td>
              </tr>
            </tbody>
          </table>
        </div>
      </template>
    </template>
  </section>
</template>

<style scoped>
.title { margin: 0 0 var(--space-2); font-size: var(--font-size-title-l); font-weight: 900; }
.h2 { margin: var(--space-5) 0 var(--space-2); font-size: var(--font-size-body); font-weight: 900; }
</style>
