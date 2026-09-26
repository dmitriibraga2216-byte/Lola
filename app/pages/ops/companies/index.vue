<script setup lang="ts">
/**
 * Консоль оператора → «Компанії» (docs/24 §4.1, docs/25 §7 п. 6): поиск, фильтры по тарифу, статусу
 * и меткам, постранично ключевым курсором. Метки считает сервер; «прострочена оплата» видна только
 * ролям с правом на деньги.
 */
definePageMeta({ layout: 'ops', middleware: 'ops-auth' })
const { t } = useI18n()
const { formatShortDate } = useFormat()
const { ops, raw, can } = useOps()

interface Row { id: string, slug: string, name: string, status: string, plan: string, createdAt: string, activeUsers: number, flags: string[] }
interface Plan { code: string, name: string }

const rows = ref<Row[]>([])
const cursor = ref<string | null>(null)
const plans = ref<Plan[]>([])
const loading = ref(false)
const error = ref('')
const filter = reactive({ q: '', plan: '', status: '', flag: '' })
const STATUSES = ['active', 'suspended', 'archived'] as const
const flags = computed(() => ['limit_near', 'suspended', ...(can('billing.read') ? ['payment_overdue'] : [])])

async function load(more = false) {
  if (loading.value) return
  loading.value = true
  error.value = ''
  try {
    const query = Object.fromEntries(Object.entries({ ...filter, cursor: more ? cursor.value : undefined }).filter(([, v]) => v))
    const r = await raw<{ data: Row[], meta: { cursor: string | null } }>('/companies', { query })
    rows.value = more ? [...rows.value, ...r.data] : r.data
    cursor.value = r.meta.cursor
  }
  catch (err) { error.value = apiErrorOf(err).message }
  finally { loading.value = false }
}

let timer: ReturnType<typeof setTimeout> | undefined
watch(() => filter.q, () => { clearTimeout(timer); timer = setTimeout(() => load(), 300) })
watch(() => [filter.plan, filter.status, filter.flag], () => load())
onMounted(async () => {
  await load()
  try { plans.value = await ops<Plan[]>('/plans') }
  catch { /* фильтр тарифа без названий — коды */ }
})
const planName = (code: string) => plans.value.find(p => p.code === code)?.name ?? code
const flagClass = (f: string) => f === 'limit_near' ? 'sun' : 'coral'
</script>

<template>
  <section>
    <h1 class="title">{{ t('opsConsole.nav.companies') }}</h1>
    <div class="filters">
      <label class="sr" for="c-q">{{ t('opsConsole.companies.search') }}</label>
      <input id="c-q" v-model="filter.q" class="field" type="search" :placeholder="t('opsConsole.companies.search')">
      <label class="sr" for="c-plan">{{ t('opsConsole.companies.plan') }}</label>
      <select id="c-plan" v-model="filter.plan" class="field">
        <option value="">{{ t('opsConsole.companies.anyPlan') }}</option>
        <option v-for="p in plans" :key="p.code" :value="p.code">{{ p.name }}</option>
      </select>
      <label class="sr" for="c-status">{{ t('opsConsole.companies.status') }}</label>
      <select id="c-status" v-model="filter.status" class="field">
        <option value="">{{ t('opsConsole.companies.anyStatus') }}</option>
        <option v-for="s in STATUSES" :key="s" :value="s">{{ t(`opsConsole.status.${s}`) }}</option>
      </select>
      <label class="sr" for="c-flag">{{ t('opsConsole.companies.flag') }}</label>
      <select id="c-flag" v-model="filter.flag" class="field">
        <option value="">{{ t('opsConsole.companies.anyFlag') }}</option>
        <option v-for="f in flags" :key="f" :value="f">{{ t(`opsConsole.flags.${f}`) }}</option>
      </select>
    </div>
    <p v-if="error" class="error-text" role="alert">{{ error }}</p>
    <div class="table-wrap">
      <table class="table" data-testid="ops-companies">
        <thead>
          <tr>
            <th>{{ t('opsConsole.companies.name') }}</th>
            <th>{{ t('opsConsole.companies.plan') }}</th>
            <th>{{ t('opsConsole.companies.status') }}</th>
            <th class="num">{{ t('opsConsole.companies.users') }}</th>
            <th>{{ t('opsConsole.companies.created') }}</th>
          </tr>
        </thead>
        <tbody>
          <tr v-for="r in rows" :key="r.id">
            <td>
              <NuxtLink :to="`/ops/companies/${r.id}`" class="link"><b>{{ r.name }}</b></NuxtLink>
              <span class="sub">{{ r.slug }}</span>
              <span v-if="r.flags.length" class="chips flags">
                <span v-for="f in r.flags" :key="f" class="badge" :class="flagClass(f)">{{ t(`opsConsole.flags.${f}`) }}</span>
              </span>
            </td>
            <td>{{ planName(r.plan) }}</td>
            <td><span class="badge" :class="r.status === 'active' ? 'teal' : 'muted'">{{ t(`opsConsole.status.${r.status}`) }}</span></td>
            <td class="num">{{ r.activeUsers }}</td>
            <td>{{ formatShortDate(new Date(r.createdAt)) }}</td>
          </tr>
          <tr v-if="!rows.length && !loading"><td colspan="5" class="muted">{{ t('opsConsole.companies.empty') }}</td></tr>
        </tbody>
      </table>
    </div>
    <LoadMore v-if="cursor" :loading="loading" @more="load(true)" />
  </section>
</template>

<style scoped>
.title { margin: 0 0 var(--space-4); font-size: var(--font-size-title-l); font-weight: 900; }
.filters { display: grid; grid-template-columns: repeat(auto-fit, minmax(160px, 1fr)); gap: var(--space-2); margin-bottom: var(--space-4); }
.sr { position: absolute; width: 1px; height: 1px; overflow: hidden; clip: rect(0 0 0 0); white-space: nowrap; }
.flags { margin-top: var(--space-1); }
</style>
