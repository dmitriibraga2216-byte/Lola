<script setup lang="ts">
/**
 * Консоль оператора → «Метрики» (docs/24 §4.6, §3.12): активність, обсяг медіа, збої фонових задач.
 * Ті самі показники, що в KPI старої панелі `/ops`, — рахує `platformMetrics()`.
 */
definePageMeta({ layout: 'ops', middleware: 'ops-auth' })
const { t } = useI18n()
const { ops } = useOps()

const metrics = ref<Record<string, unknown> | null>(null)
const error = ref('')
onMounted(async () => {
  try { metrics.value = await ops<Record<string, unknown>>('/metrics') }
  catch (err) { error.value = apiErrorOf(err).message }
})
const KPI_KEYS = ['tenants_active', 'trials_ending', 'users_active', 'dau', 'wau', 'attempts_today', 'notifications_queued', 'notifications_failed_24h', 'webhooks_failed_24h'] as const
const gb = (b: unknown) => (Number(b) / 1024 / 1024 / 1024).toFixed(1)
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
  </section>
</template>

<style scoped>
.title { margin: 0 0 var(--space-2); font-size: var(--font-size-title-l); font-weight: 900; }
</style>
