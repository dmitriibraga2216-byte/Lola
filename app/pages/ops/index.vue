<script setup lang="ts">
/** Панель оператора платформы (docs/03 §3.12). Отдельный вход, отдельная сессия. */
definePageMeta({ layout: false })
const { t } = useI18n()

interface Me { adminId: string, email: string, fullName: string }
interface Tenant { id: string, slug: string, name: string, status: string, plan: string, trial_ends_at: string | null, active_users: number, total_users: number, wau: number, media_bytes: string, completed_30d: number }
interface Plan { code: string, name: string, maxUsers: number | null, priceUah: number | null }

const me = ref<Me | null>(null)
const login = reactive({ email: '', password: '' })
const tenants = ref<Tenant[]>([])
const plans = ref<Plan[]>([])
const metrics = ref<Record<string, unknown> | null>(null)
const error = ref('')
const notice = ref('')
const newTenant = reactive({ slug: '', name: '', adminName: '', adminPhone: '', plan: 'trial' })
const impFor = ref<Tenant | null>(null)
const impUsers = ref<{ id: string, fullName: string, phone: string | null, status: string }[]>([])
const impForm = reactive({ userId: '', reason: '' })

// Нетипизированный вызов: типизированные роуты Nitro при сотнях эндпоинтов дают TS2589
const rawFetch = $fetch as unknown as <T>(url: string, opts?: unknown) => Promise<T>
async function ops<T>(path: string, opts: Record<string, unknown> = {}): Promise<T> {
  const res = await rawFetch<{ data: T }>(`/api/v1/platform${path}`, opts)
  return res.data
}

async function load() {
  try {
    me.value = await ops<Me>('/me')
    ;[tenants.value, plans.value, metrics.value] = await Promise.all([ops<Tenant[]>('/tenants'), ops<Plan[]>('/plans'), ops<Record<string, unknown>>('/metrics')])
  }
  catch { me.value = null }
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
    await load()
  }
  catch (err) { error.value = apiErrorOf(err).message }
}
async function setTenant(tn: Tenant, patch: Record<string, unknown>) {
  await ops(`/tenants/${tn.id}`, { method: 'PATCH', body: patch })
  await load()
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
    await ops(`/tenants/${impFor.value.id}/impersonate`, { method: 'POST', body: impForm })
    window.open('/', '_blank')
    impFor.value = null
  }
  catch (err) { error.value = apiErrorOf(err).message }
}
const gb = (b: string) => (Number(b) / 1024 / 1024 / 1024).toFixed(2)
const fmt = (d: string | null) => d ? new Date(d).toLocaleDateString('uk') : '—'
</script>

<template>
  <div class="ops">
    <header class="top">
      <b class="brand">Lola · {{ t('ops.title') }}</b>
      <span v-if="me" class="who">{{ me.email }} <button class="chip" @click="logout">{{ t('home.logout') }}</button></span>
    </header>
    <p v-if="error" class="error">{{ error }}</p>
    <p v-if="notice" class="notice">{{ notice }}</p>

    <main v-if="!me" class="login">
      <input v-model="login.email" type="email" placeholder="e-mail" @keyup.enter="doLogin">
      <input v-model="login.password" type="password" :placeholder="t('ops.password')" @keyup.enter="doLogin">
      <button class="primary" @click="doLogin">{{ t('login.signIn') }}</button>
    </main>

    <main v-else class="body">
      <div v-if="metrics" class="kpis">
        <div v-for="k in ['tenants_active', 'trials_ending', 'users_active', 'dau', 'wau', 'attempts_today', 'notifications_queued', 'notifications_failed_24h', 'webhooks_failed_24h']" :key="k" :class="['kpi', { coral: k.includes('failed') && Number(metrics[k]) > 0 }]">
          <b>{{ metrics[k] }}</b><span>{{ t(`ops.kpi.${k}`) }}</span>
        </div>
        <div class="kpi"><b>{{ gb(String(metrics.media_bytes)) }} GB</b><span>{{ t('ops.kpi.media') }}</span></div>
      </div>

      <table class="table">
        <thead><tr><th>{{ t('ops.col.tenant') }}</th><th>{{ t('ops.col.plan') }}</th><th>{{ t('ops.col.trial') }}</th><th>{{ t('ops.col.users') }}</th><th>WAU</th><th>{{ t('ops.col.completed') }}</th><th>{{ t('ops.col.status') }}</th><th /></tr></thead>
        <tbody>
          <tr v-for="tn in tenants" :key="tn.id">
            <td><b>{{ tn.name }}</b> <span class="sub">{{ tn.slug }}</span></td>
            <td><select :value="tn.plan" @change="setTenant(tn, { plan: ($event.target as HTMLSelectElement).value })"><option v-for="p in plans" :key="p.code" :value="p.code">{{ p.name }}</option></select></td>
            <td :class="{ coral: tn.trial_ends_at && new Date(tn.trial_ends_at) < new Date(Date.now() + 7 * 86400000) }">{{ tn.plan === 'trial' ? fmt(tn.trial_ends_at) : '—' }}</td>
            <td>{{ tn.active_users }} / {{ tn.total_users }}</td><td>{{ tn.wau }}</td><td>{{ tn.completed_30d }}</td>
            <td><span :class="['badge', tn.status]">{{ tn.status }}</span></td>
            <td class="acts">
              <button v-if="tn.status === 'active'" class="chip" @click="setTenant(tn, { status: 'suspended' })">{{ t('ops.suspend') }}</button>
              <button v-else class="chip" @click="setTenant(tn, { status: 'active' })">{{ t('ops.activate') }}</button>
              <button class="chip warn" @click="openImpersonate(tn)">{{ t('ops.impersonate') }}</button>
            </td>
          </tr>
        </tbody>
      </table>

      <section class="card">
        <h2>{{ t('ops.newTenant') }}</h2>
        <div class="grid">
          <input v-model="newTenant.name" :placeholder="t('ops.f.name')">
          <input v-model="newTenant.slug" placeholder="slug (a-z, 0-9, -)">
          <input v-model="newTenant.adminName" :placeholder="t('ops.f.adminName')">
          <div class="phone"><span>+380</span><input v-model="newTenant.adminPhone" inputmode="numeric" maxlength="9" placeholder="__ ___ __ __"></div>
          <select v-model="newTenant.plan"><option v-for="p in plans" :key="p.code" :value="p.code">{{ p.name }}</option></select>
          <button class="primary" :disabled="!newTenant.name || !newTenant.slug || !newTenant.adminName || newTenant.adminPhone.replace(/\D/g, '').length !== 9" @click="createTenant">{{ t('ops.create') }}</button>
        </div>
        <p class="sub">{{ t('ops.createHint') }}</p>
      </section>
    </main>

    <div v-if="impFor" class="modal-backdrop" @click.self="impFor = null">
      <div class="modal">
        <h2>{{ t('ops.impersonate') }}: {{ impFor.name }}</h2>
        <select v-model="impForm.userId"><option value="" disabled>{{ t('ops.pickUser') }}</option><option v-for="u in impUsers.filter(x => x.status === 'active')" :key="u.id" :value="u.id">{{ u.fullName }} · {{ u.phone }}</option></select>
        <input v-model="impForm.reason" :placeholder="t('ops.reasonHint')">
        <p class="sub">{{ t('ops.impWarn') }}</p>
        <div class="actions"><button class="chip" @click="impFor = null">{{ t('common.cancel') }}</button><button class="primary" :disabled="!impForm.userId || impForm.reason.length < 10" @click="impersonate">{{ t('ops.enter') }}</button></div>
      </div>
    </div>
  </div>
</template>

<style scoped>
.ops { min-height: 100dvh; background: var(--color-ink); color: var(--color-bg-soft); font-family: var(--font-family); }
.top { display: flex; align-items: center; justify-content: space-between; padding: var(--space-3) var(--space-5); border-bottom: 1px solid rgb(255 255 255 / 10%); }
.brand { font-weight: 900; }
.who { display: flex; gap: var(--space-3); align-items: center; font-size: var(--font-size-body-s); opacity: 0.8; }
.login { max-width: 360px; margin: 15vh auto; display: grid; gap: var(--space-3); padding: var(--space-4); }
.body { padding: var(--space-5); display: grid; gap: var(--space-5); }
input, select { font: inherit; border: 1px solid rgb(255 255 255 / 20%); border-radius: var(--radius-s); padding: var(--space-2) var(--space-3); background: rgb(255 255 255 / 6%); color: var(--color-bg-soft); }
.phone { display: flex; align-items: center; gap: var(--space-1); border: 1px solid rgb(255 255 255 / 20%); border-radius: var(--radius-s); padding: 0 var(--space-3); }
.phone input { border: none; background: none; flex: 1; }
.kpis { display: flex; gap: var(--space-3); flex-wrap: wrap; }
.kpi { background: rgb(255 255 255 / 6%); border-radius: var(--radius-m); padding: var(--space-3) var(--space-4); display: grid; text-align: center; min-width: 110px; }
.kpi b { font-size: var(--font-size-title-l); font-weight: 900; color: var(--color-teal); }
.kpi.coral b { color: var(--color-coral); }
.kpi span { font-size: var(--font-size-body-s); opacity: 0.7; }
.table { width: 100%; border-collapse: collapse; }
th { text-align: left; font-size: var(--font-size-body-s); opacity: 0.6; padding: var(--space-2); border-bottom: 1px solid rgb(255 255 255 / 15%); }
td { padding: var(--space-2); border-bottom: 1px solid rgb(255 255 255 / 8%); vertical-align: middle; }
.acts { display: flex; gap: var(--space-1); }
.chip { font: inherit; font-size: var(--font-size-body-s); font-weight: 700; border: 1px solid rgb(255 255 255 / 25%); background: transparent; color: var(--color-bg-soft); border-radius: var(--radius-pill); padding: 2px var(--space-3); cursor: pointer; }
.chip.warn { border-color: var(--color-coral); color: var(--color-coral); }
.primary { font: inherit; font-weight: 800; border: none; background: var(--color-sun); color: var(--color-ink); border-radius: var(--radius-pill); padding: var(--space-2) var(--space-5); cursor: pointer; }
.primary:disabled { opacity: 0.4; }
.badge { font-size: var(--font-size-body-s); font-weight: 700; border-radius: var(--radius-pill); padding: 2px var(--space-3); background: rgb(255 255 255 / 15%); }
.badge.active { background: var(--color-teal); color: var(--color-teal-deep); }
.badge.suspended { background: var(--color-coral); color: var(--color-coral-deep); }
.card { background: rgb(255 255 255 / 6%); border-radius: var(--radius-l); padding: var(--space-4); display: grid; gap: var(--space-3); }
.card h2 { margin: 0; font-weight: 800; font-size: var(--font-size-title-l); }
.grid { display: grid; grid-template-columns: repeat(auto-fit, minmax(200px, 1fr)); gap: var(--space-2); }
.coral { color: var(--color-coral); font-weight: 700; }
.sub { font-size: var(--font-size-body-s); opacity: 0.6; margin: 0; }
.error { color: var(--color-coral); padding: 0 var(--space-5); }
.notice { color: var(--color-teal); padding: 0 var(--space-5); }
.modal-backdrop { position: fixed; inset: 0; background: rgb(0 0 0 / 60%); display: grid; place-items: center; padding: var(--space-4); }
.modal { background: var(--color-ink); border: 1px solid rgb(255 255 255 / 20%); border-radius: var(--radius-xl); padding: var(--space-5); width: min(480px, 100%); display: grid; gap: var(--space-3); }
.modal h2 { margin: 0; font-weight: 800; font-size: var(--font-size-title-l); }
.actions { display: flex; justify-content: flex-end; gap: var(--space-2); }
</style>
