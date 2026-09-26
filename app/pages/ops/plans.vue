<script setup lang="ts">
/**
 * Консоль оператора → «Тарифи» (docs/24 §4.4, docs/v2/35-billing-limits.md §3.4, §7.1).
 *
 * Лише перегляд: ручка `GET /platform/plans` — єдина реалізована на сьогодні (докс/24 §9
 * обіцяє «CRUD `/platform/plans»`, але створення й правка тарифів — окремий PR, не вигадуємо
 * тут форму без ручки). Зміна тарифу конкретній компанії — вкладка «Тариф і оплата» картки.
 */
definePageMeta({ layout: 'ops', middleware: 'ops-auth' })
const { t } = useI18n()
const { ops } = useOps()

interface Plan {
  code: string, name: string, titleUk: string | null, tier: number
  maxUsers: number | null, maxStorageGb: number | null, maxSmsPerMonth: number | null, maxCandidates: number | null
  maxAiGenerateOps: number | null, maxAiReviewOps: number | null, maxAiInterviewOps: number | null, maxExportRows: number | null
  aiIncluded: boolean, aiTermDays: number | null, priceUah: number | null, isActive: boolean, sort: number
}
const plans = ref<Plan[]>([])
const error = ref('')
onMounted(async () => {
  try { plans.value = await ops<Plan[]>('/plans') }
  catch (err) { error.value = apiErrorOf(err).message }
})
const n = (v: number | null) => v == null ? t('opsConsole.overview.unlimited') : String(v)
</script>

<template>
  <section>
    <h1 class="title">{{ t('opsConsole.nav.plans') }}</h1>
    <p class="help">{{ t('opsConsole.plansPage.hint') }}</p>
    <p v-if="error" class="error-text" role="alert">{{ error }}</p>
    <div class="table-wrap">
      <table class="table" data-testid="ops-plans">
        <thead>
          <tr>
            <th>{{ t('opsConsole.plansPage.name') }}</th>
            <th class="num">{{ t('opsConsole.limits.users') }}</th>
            <th class="num">{{ t('opsConsole.limits.storageGb') }}</th>
            <th class="num">{{ t('opsConsole.limits.smsPerMonth') }}</th>
            <th class="num">{{ t('opsConsole.limits.candidates') }}</th>
            <th class="num">{{ t('opsConsole.plansPage.price') }}</th>
            <th>{{ t('opsConsole.plansPage.state') }}</th>
          </tr>
        </thead>
        <tbody>
          <tr v-for="p in plans" :key="p.code">
            <td><b>{{ p.name }}</b><span class="sub">{{ p.code }}</span></td>
            <td class="num">{{ n(p.maxUsers) }}</td>
            <td class="num">{{ n(p.maxStorageGb) }}</td>
            <td class="num">{{ n(p.maxSmsPerMonth) }}</td>
            <td class="num">{{ n(p.maxCandidates) }}</td>
            <td class="num">{{ p.priceUah != null ? `${p.priceUah} ₴` : '—' }}</td>
            <td><span class="badge" :class="p.isActive ? 'teal' : 'muted'">{{ t(p.isActive ? 'opsConsole.plansPage.active' : 'opsConsole.plansPage.inactive') }}</span></td>
          </tr>
          <tr v-if="!plans.length"><td colspan="7" class="muted">{{ t('opsConsole.plansPage.empty') }}</td></tr>
        </tbody>
      </table>
    </div>
  </section>
</template>

<style scoped>
.title { margin: 0 0 var(--space-2); font-size: var(--font-size-title-l); font-weight: 900; }
</style>
