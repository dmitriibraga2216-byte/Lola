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

// ── Створення компанії (docs/24 §4.3, `tenants.index.post`) ────────────
const showCreate = ref(false)
const busy = ref(false)
const notice = ref('')
const draft = reactive({ name: '', slug: '', adminName: '', adminPhone: '', plan: 'trial' })
const phoneDigits = computed(() => draft.adminPhone.replace(/\D/g, ''))
const createReady = computed(() => draft.name.trim().length >= 2 && /^[a-z0-9-]{3,40}$/.test(draft.slug) && draft.adminName.trim().length >= 2 && phoneDigits.value.length === 9)

async function createCompany() {
  if (!createReady.value || busy.value) return
  error.value = ''
  busy.value = true
  try {
    const r = await ops<{ tenantId: string }>('/tenants', {
      method: 'POST',
      body: { name: draft.name.trim(), slug: draft.slug.trim(), adminName: draft.adminName.trim(), adminPhone: `+380${phoneDigits.value}`, plan: draft.plan },
    })
    notice.value = t('opsConsole.companies.created', { slug: draft.slug })
    Object.assign(draft, { name: '', slug: '', adminName: '', adminPhone: '', plan: 'trial' })
    showCreate.value = false
    await load()
    await navigateTo(`/ops/companies/${r.tenantId}`)
  }
  catch (err) { error.value = apiErrorOf(err).message }
  finally { busy.value = false }
}

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
    <div class="head">
      <h1 class="title">{{ t('opsConsole.nav.companies') }}</h1>
      <button v-if="can('tenant.create')" type="button" class="btn primary" @click="showCreate = !showCreate">{{ t('opsConsole.companies.create') }}</button>
    </div>
    <p v-if="notice" class="note teal" role="status">{{ notice }} <button type="button" class="link" @click="notice = ''">×</button></p>

    <form v-if="showCreate" class="card create" data-testid="ops-company-create" @submit.prevent="createCompany">
      <h2>{{ t('opsConsole.companies.create') }}</h2>
      <div class="row">
        <div><label class="label" for="nc-name">{{ t('opsConsole.companies.f.name') }}</label><input id="nc-name" v-model="draft.name" class="field" maxlength="120" required></div>
        <div><label class="label" for="nc-slug">{{ t('opsConsole.companies.f.slug') }}</label><input id="nc-slug" v-model="draft.slug" class="field" placeholder="a-z, 0-9, -" maxlength="40" required></div>
        <div><label class="label" for="nc-admin">{{ t('opsConsole.companies.f.adminName') }}</label><input id="nc-admin" v-model="draft.adminName" class="field" maxlength="200" required></div>
        <div>
          <label class="label" for="nc-phone">{{ t('opsConsole.companies.f.adminPhone') }}</label>
          <div class="phone"><span>+380</span><input id="nc-phone" v-model="draft.adminPhone" class="field" inputmode="numeric" maxlength="9" placeholder="__ ___ __ __"></div>
        </div>
        <div>
          <label class="label" for="nc-plan">{{ t('opsConsole.companies.plan') }}</label>
          <select id="nc-plan" v-model="draft.plan" class="field"><option v-for="p in plans" :key="p.code" :value="p.code">{{ p.name }}</option></select>
        </div>
      </div>
      <p class="help">{{ t('opsConsole.companies.createHint') }}</p>
      <div class="chips"><button type="submit" class="btn primary" :disabled="!createReady || busy">{{ t('opsConsole.companies.create') }}</button></div>
    </form>

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
.head { display: flex; align-items: flex-end; justify-content: space-between; gap: var(--space-3); flex-wrap: wrap; margin-bottom: var(--space-3); }
.title { margin: 0; font-size: var(--font-size-title-l); font-weight: 900; }
.create { margin-bottom: var(--space-4); display: grid; gap: var(--space-2); }
.create h2 { margin: 0; font-size: var(--font-size-body); font-weight: 900; }
.row { display: grid; grid-template-columns: repeat(auto-fit, minmax(180px, 1fr)); gap: var(--space-2); }
.phone { display: flex; align-items: center; gap: var(--space-1); border: 1px solid var(--color-bg-line); border-radius: var(--radius-s); padding: 0 var(--space-3); background: var(--color-bg); }
.phone input.field { border: none; padding-left: 0; }
.filters { display: grid; grid-template-columns: repeat(auto-fit, minmax(160px, 1fr)); gap: var(--space-2); margin-bottom: var(--space-4); }
.sr { position: absolute; width: 1px; height: 1px; overflow: hidden; clip: rect(0 0 0 0); white-space: nowrap; }
.flags { margin-top: var(--space-1); }
</style>
