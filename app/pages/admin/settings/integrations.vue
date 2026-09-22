<script setup lang="ts">
definePageMeta({ layout: 'admin', middleware: 'admin-scope', requiredScope: 'settings.integrations' })

const { t, te } = useI18n()
const { api } = useApi()

type Provider = 'telegram' | 'sms' | 'smtp'
interface Status { provider: Provider, state: 'not_configured' | 'connected' | 'failing', accountLabel: string | null, lastOkAt: string | null, lastError: string | null, keys: { key: string, set: boolean }[] }
interface Endpoint { id: string, url: string, events: string[], isActive: boolean, description: string | null, delivered: number, failed: number }
interface Delivery { id: string, event: string, status: string, attempt: number, statusCode: number | null, responseBody: string | null, createdAt: string }
interface Token { id: string, name: string, prefix: string, scopes: string[], lastUsedAt: string | null, expiresAt: string | null, revokedAt: string | null }

const providers: Provider[] = ['telegram', 'sms', 'smtp']
const statuses = ref<Record<string, Status>>({})
// OAuth-провайдеры (docs/09 §9.2–9.3): ссылку даёт сервер, окно закрывается само, панель следит и за окном, и за postMessage
interface OAuthStatus { provider: string, configured: boolean, connected: boolean, state: 'not_configured' | 'not_connected' | 'connected' | 'failing', accountLabel: string | null, lastOkAt: string | null, lastError: string | null, connectedAt: string | null }
const oauth = ref<Record<string, OAuthStatus>>({})
const connecting = ref<string | null>(null)
const oauthError = ref<Record<string, string>>({})
async function loadOAuth() { for (const p of ['google', 'zoom']) { try { oauth.value[p] = await api<OAuthStatus>(`/integrations/${p}/status`) } catch { /* нет прав */ } } }
async function connectOAuth(p: string) {
  oauthError.value[p] = ''
  try {
    const { url } = await api<{ url: string }>(`/integrations/${p}/auth-url`)
    connecting.value = p
    const win = window.open(url, 'lola-oauth', 'width=520,height=680')
    if (!win) { connecting.value = null; oauthError.value[p] = t('integrations.popupBlocked'); return }
    const done = async () => { window.removeEventListener('message', onMsg); connecting.value = null; await loadOAuth() }
    const onMsg = (e: MessageEvent) => { if (e.data?.type === 'lola:oauth') { if (!e.data.ok) oauthError.value[p] = e.data.message; done() } }
    window.addEventListener('message', onMsg)
    const poll = setInterval(() => { if (!win || win.closed) { clearInterval(poll); done() } }, 700)
  } catch (err) { oauthError.value[p] = apiErrorOf(err).message }
}
/** Коды провайдера → одна понятная причина: 401 доступ отозван, 403 API ещё не открыт, 429 квота. */
function humanError(e: string | null) {
  const code = e?.match(/^(\d{3})/)?.[1]
  if (code === '401' || /invalid_grant/.test(e ?? '')) return t('integrations.err401')
  if (code === '403') return t('integrations.err403')
  if (code === '429') return t('integrations.err429')
  return e ?? ''
}
async function disconnectOAuth(p: string) { await api(`/integrations/${p}/disconnect`, { method: 'POST' }); await loadOAuth() }
const wsImport = reactive({ domain: '', defaultPosition: '', defaultOrgUnit: '', defaultLocation: '', result: null as null | { fetched: number, stats: Record<string, number>, errors: { row: string, errors: string[] }[] }, busy: false })
async function importWorkspace(apply: boolean) {
  wsImport.busy = true; oauthError.value.google = ''
  try { wsImport.result = await api('/integrations/google/import-people', { method: 'POST', body: { domain: wsImport.domain || undefined, apply, defaultPosition: wsImport.defaultPosition, defaultOrgUnit: wsImport.defaultOrgUnit, defaultLocation: wsImport.defaultLocation } }) }
  catch (err) { oauthError.value.google = apiErrorOf(err).message } finally { wsImport.busy = false }
}
const forms = reactive<Record<string, Record<string, string>>>({ telegram: {}, sms: {}, smtp: {} })
// «Надіслати тестове повідомлення» — перевірка SMTP-зʼєднання без постановки в чергу (docs/09 §9.7.1)
const smtpTestTo = ref('')
const smtpTestResult = ref<'ok' | 'fail' | null>(null)
async function testSmtp() {
  smtpTestResult.value = null
  try { await api('/settings/integrations/smtp/test', { method: 'POST', body: { to: smtpTestTo.value } }); smtpTestResult.value = 'ok' }
  catch { smtpTestResult.value = 'fail' }
}
const webhooks = ref<{ endpoints: Endpoint[], events: string[] }>({ endpoints: [], events: [] })
const whForm = reactive({ url: '', events: [] as string[], description: '' })
const whSecret = ref('')
const deliveries = ref<{ id: string, list: Delivery[] } | null>(null)
const tokens = ref<{ tokens: Token[], scopes: string[] }>({ tokens: [], scopes: [] })
const tokForm = reactive({ name: '', scopes: [] as string[], expiresInDays: 365 })
const tokShown = ref('')
const error = ref('')
const notice = ref('')

async function load() {
  try {
    for (const p of providers) statuses.value[p] = await api<Status>(`/settings/integrations/${p}`)
    await loadOAuth()
    webhooks.value = await api('/settings/webhooks')
    tokens.value = await api('/settings/api-tokens')
  }
  catch (err) { error.value = apiErrorOf(err).message }
}
onMounted(load)

async function saveProvider(p: Provider) {
  error.value = ''
  const values = Object.fromEntries(Object.entries(forms[p]!).filter(([, v]) => v.trim()))
  if (!Object.keys(values).length) return
  try {
    await api(`/settings/integrations/${p}`, { method: 'PUT', body: { values, accountLabel: values.bot_username || values.sender || values.from } })
    forms[p] = {}
    notice.value = t('common.saved')
    await load()
  }
  catch (err) { error.value = apiErrorOf(err).message }
}
async function disconnectProvider(p: Provider) {
  if (!confirm(t('integrations.disconnectConfirm'))) return
  await api(`/settings/integrations/${p}/disconnect`, { method: 'POST' })
  await load()
}
async function createWebhook() {
  error.value = ''
  try {
    const r = await api<{ id: string, secret: string }>('/settings/webhooks', { method: 'POST', body: whForm })
    whSecret.value = r.secret
    Object.assign(whForm, { url: '', events: [], description: '' })
    await load()
  }
  catch (err) { error.value = apiErrorOf(err).message }
}
async function toggleWebhook(e: Endpoint) { await api(`/settings/webhooks/${e.id}`, { method: 'PATCH', body: { isActive: !e.isActive } }); await load() }
async function showDeliveries(e: Endpoint) { deliveries.value = { id: e.id, list: await api(`/settings/webhooks/${e.id}/deliveries`) } }
async function retry(d: Delivery) { if (deliveries.value) { await api(`/settings/webhooks/${deliveries.value.id}/retry`, { method: 'POST', body: { deliveryId: d.id } }); await showDeliveries({ id: deliveries.value.id } as Endpoint) } }
async function createToken() {
  error.value = ''
  try {
    const r = await api<{ token: string }>('/settings/api-tokens', { method: 'POST', body: tokForm })
    tokShown.value = r.token
    Object.assign(tokForm, { name: '', scopes: [] })
    await load()
  }
  catch (err) { error.value = apiErrorOf(err).message }
}
async function revoke(tk: Token) { if (confirm(t('integrations.revokeConfirm'))) { await api(`/settings/api-tokens/${tk.id}`, { method: 'DELETE' }); await load() } }
const fmt = (d: string | null) => d ? new Date(d).toLocaleString('uk', { day: 'numeric', month: 'short', hour: '2-digit', minute: '2-digit' }) : '—'
</script>

<template>
  <div>
    <h1>{{ t('admin.nav.integrations') }}</h1>
    <p v-if="error" class="error">{{ error }}</p>
    <p v-if="notice" class="notice">{{ notice }}</p>

    <!-- Провайдеры (docs/09 §9.3: состояния с приоритетом) -->
    <div class="grid">
      <section v-for="p in providers" :key="p" class="card">
        <div class="card-head">
          <h2>{{ t(`integrations.${p}`) }}</h2>
          <span v-if="statuses[p]" :class="['badge', statuses[p]!.state]">{{ t(`integrations.state.${statuses[p]!.state}`) }}</span>
        </div>
        <template v-if="statuses[p]">
          <p v-if="statuses[p]!.state === 'failing'" class="fail">{{ statuses[p]!.lastError }}</p>
          <p v-else-if="statuses[p]!.state === 'connected'" class="sub">{{ statuses[p]!.accountLabel || '' }} · {{ t('integrations.lastOk', { at: fmt(statuses[p]!.lastOkAt) }) }}</p>
          <p v-else class="sub">{{ t('integrations.notConfiguredHint') }}</p>
          <div v-for="k in statuses[p]!.keys" :key="k.key" class="field-row">
            <div class="row">
              <label>{{ t(`integrations.field.${k.key}`, k.key) }} <span v-if="k.set" class="teal">✓</span></label>
              <select v-if="k.key === 'ssl' || k.key === 'debug_mode'" v-model="forms[p]![k.key]" class="bool">
                <option value="">{{ k.set ? '••••••••' : '—' }}</option>
                <option value="true">{{ t('common.yes') }}</option>
                <option value="false">{{ t('common.no') }}</option>
              </select>
              <input v-else v-model="forms[p]![k.key]" :type="k.key.endsWith('_ms') || k.key.endsWith('_mb') ? 'number' : k.key.includes('key') || k.key.includes('token') || k.key.includes('url') ? 'password' : 'text'" :placeholder="k.set ? '••••••••' : ''" autocomplete="off">
            </div>
            <p v-if="te(`integrations.hint.${k.key}`)" class="sub hint">{{ t(`integrations.hint.${k.key}`) }}</p>
          </div>
          <div class="actions">
            <button class="primary" @click="saveProvider(p)">{{ t('integrations.connect') }}</button>
            <button v-if="statuses[p]!.state !== 'not_configured'" class="chip danger" @click="disconnectProvider(p)">{{ t('integrations.disconnect') }}</button>
          </div>
          <div v-if="p === 'smtp' && statuses[p]!.state !== 'not_configured'" class="row">
            <input v-model="smtpTestTo" type="email" :placeholder="t('integrations.smtpTestTo')" class="grow">
            <button class="chip" :disabled="!smtpTestTo" @click="testSmtp">{{ t('integrations.smtpTestSend') }}</button>
            <span v-if="smtpTestResult === 'ok'" class="teal">{{ t('integrations.smtpTestOk') }}</span>
            <span v-if="smtpTestResult === 'fail'" class="fail">{{ t('integrations.smtpTestFail') }}</span>
          </div>
          <p v-if="p === 'smtp'" class="sub hint">{{ t('integrations.smtpTlsHint') }}</p>
        </template>
      </section>
    </div>

    <!-- OAuth: Google и Zoom (docs/09 §9.2) -->
    <div class="grid">
      <section v-for="p in ['google', 'zoom']" :key="p" class="card">
        <div class="card-head">
          <h2>{{ t(`integrations.${p}`) }}</h2>
          <span v-if="oauth[p]" :class="['badge', oauth[p]!.state]">{{ t(`integrations.state.${oauth[p]!.state}`) }}</span>
        </div>
        <template v-if="oauth[p]">
          <p v-if="oauthError[p]" class="fail">{{ oauthError[p] }} <button class="chip" @click="connectOAuth(p)">{{ t('integrations.retry') }}</button></p>
          <p v-if="oauth[p]!.state === 'not_configured'" class="sub">{{ t('integrations.oauthNotConfigured') }}</p>
          <p v-else-if="oauth[p]!.state === 'not_connected'" class="sub">{{ t('integrations.oauthNotConnected') }}</p>
          <p v-else-if="oauth[p]!.state === 'failing'" class="fail">{{ t('integrations.silentSince', { at: fmt(oauth[p]!.lastOkAt) }) }} · {{ humanError(oauth[p]!.lastError) }}</p>
          <p v-else class="sub">{{ t('integrations.connectedAs', { account: oauth[p]!.accountLabel ?? '', at: fmt(oauth[p]!.lastOkAt ?? oauth[p]!.connectedAt) }) }}</p>
          <p class="sub">{{ t(`integrations.${p}Uses`) }}</p>
          <div class="actions">
            <button v-if="oauth[p]!.configured && !oauth[p]!.connected" class="primary" :disabled="connecting === p" :data-testid="`oauth-connect-${p}`" @click="connectOAuth(p)">{{ connecting === p ? t('integrations.connecting') : t('integrations.connect') }}</button>
            <button v-if="oauth[p]!.connected" class="chip" :disabled="connecting === p" @click="connectOAuth(p)">{{ t('integrations.reconnect') }}</button>
            <button v-if="oauth[p]!.connected" class="chip danger" :data-testid="`oauth-disconnect-${p}`" @click="disconnectOAuth(p)">{{ t('integrations.disconnect') }}</button>
          </div>
          <details v-if="p === 'google' && oauth[p]!.connected">
            <summary class="sub">{{ t('integrations.wsImport') }}</summary>
            <div class="row"><input v-model="wsImport.domain" :placeholder="t('integrations.wsDomain')"><input v-model="wsImport.defaultPosition" :placeholder="t('integrations.wsPosition')"><input v-model="wsImport.defaultOrgUnit" :placeholder="t('integrations.wsOrgUnit')"><input v-model="wsImport.defaultLocation" :placeholder="t('integrations.wsLocation')"></div>
            <div class="actions"><button class="chip" :disabled="wsImport.busy || !wsImport.defaultPosition" @click="importWorkspace(false)">{{ t('integrations.wsPreview') }}</button><button class="primary" :disabled="wsImport.busy || !wsImport.result" @click="importWorkspace(true)">{{ t('integrations.wsApply') }}</button></div>
            <p v-if="wsImport.result" class="sub">{{ t('integrations.wsResult', { n: wsImport.result.fetched }) }} · {{ JSON.stringify(wsImport.result.stats) }}<template v-if="wsImport.result.errors.length"> · {{ wsImport.result.errors.length }} {{ t('integrations.wsErrors') }}</template></p>
          </details>
        </template>
      </section>
    </div>

    <!-- Вебхуки -->
    <section class="card wide">
      <h2>{{ t('integrations.webhooks') }}</h2>
      <p v-if="whSecret" class="secret">{{ t('integrations.secretOnce') }}<br><code>{{ whSecret }}</code></p>
      <table class="table">
        <thead><tr><th>URL</th><th>{{ t('integrations.events') }}</th><th>{{ t('integrations.delivered') }}</th><th /></tr></thead>
        <tbody>
          <tr v-for="e in webhooks.endpoints" :key="e.id" :class="{ dim: !e.isActive }">
            <td><code>{{ e.url }}</code><span v-if="e.description" class="sub"> · {{ e.description }}</span></td>
            <td class="sub">{{ e.events.join(', ') }}</td>
            <td><span class="teal">{{ e.delivered }}</span> / <span class="coral">{{ e.failed }}</span></td>
            <td class="acts"><button class="chip" @click="showDeliveries(e)">{{ t('integrations.log') }}</button><button class="chip" @click="toggleWebhook(e)">{{ e.isActive ? t('integrations.pause') : t('integrations.resume') }}</button></td>
          </tr>
        </tbody>
      </table>
      <div class="row wrap">
        <input v-model="whForm.url" placeholder="https://…" class="grow">
        <input v-model="whForm.description" :placeholder="t('integrations.descr')">
      </div>
      <div class="row wrap">
        <label v-for="ev in webhooks.events" :key="ev" class="check"><input v-model="whForm.events" type="checkbox" :value="ev"> {{ ev }}</label>
      </div>
      <button class="primary" :disabled="!whForm.url || !whForm.events.length" @click="createWebhook">{{ t('integrations.addWebhook') }}</button>
    </section>

    <!-- API-токены -->
    <section class="card wide">
      <h2>{{ t('integrations.apiTokens') }}</h2>
      <p class="sub">{{ t('integrations.apiHint') }}</p>
      <p v-if="tokShown" class="secret">{{ t('integrations.secretOnce') }}<br><code>{{ tokShown }}</code></p>
      <table class="table">
        <thead><tr><th>{{ t('assign.col.title') }}</th><th>{{ t('integrations.prefix') }}</th><th>{{ t('integrations.scopes') }}</th><th>{{ t('integrations.lastUsed') }}</th><th /></tr></thead>
        <tbody>
          <tr v-for="tk in tokens.tokens" :key="tk.id" :class="{ dim: tk.revokedAt }">
            <td><b>{{ tk.name }}</b></td><td><code>{{ tk.prefix }}…</code></td><td class="sub">{{ tk.scopes.join(', ') }}</td><td class="sub">{{ fmt(tk.lastUsedAt) }}</td>
            <td><button v-if="!tk.revokedAt" class="chip danger" @click="revoke(tk)">{{ t('integrations.revoke') }}</button><span v-else class="sub">{{ t('integrations.revoked') }}</span></td>
          </tr>
        </tbody>
      </table>
      <div class="row wrap">
        <input v-model="tokForm.name" :placeholder="t('integrations.tokenName')">
        <label class="check">{{ t('integrations.expiresDays') }} <input v-model.number="tokForm.expiresInDays" type="number" min="1" max="3650" class="num"></label>
      </div>
      <div class="row wrap scopes">
        <label v-for="sc in tokens.scopes" :key="sc" class="check"><input v-model="tokForm.scopes" type="checkbox" :value="sc"> {{ sc }}</label>
      </div>
      <button class="primary" :disabled="tokForm.name.length < 2 || !tokForm.scopes.length" @click="createToken">{{ t('integrations.createToken') }}</button>
    </section>

    <div v-if="deliveries" class="modal-backdrop" @click.self="deliveries = null">
      <div class="modal">
        <h2>{{ t('integrations.log') }}</h2>
        <table class="table">
          <thead><tr><th>{{ t('integrations.events') }}</th><th>{{ t('assign.col.status') }}</th><th>HTTP</th><th>{{ t('journals.when') }}</th><th /></tr></thead>
          <tbody>
            <tr v-for="d in deliveries.list" :key="d.id">
              <td>{{ d.event }}</td><td><span :class="['badge', d.status]">{{ d.status }}</span> <span class="sub">#{{ d.attempt }}</span></td><td>{{ d.statusCode ?? '—' }}</td><td class="sub">{{ fmt(d.createdAt) }}</td>
              <td><button v-if="d.status !== 'delivered'" class="chip" @click="retry(d)">{{ t('integrations.retry') }}</button></td>
            </tr>
          </tbody>
        </table>
      </div>
    </div>
  </div>
</template>

<style scoped>
h1 { margin: 0 0 var(--space-4); font-weight: 900; }
h2 { margin: 0; font-weight: 800; font-size: var(--font-size-title-l); }
.grid { display: grid; grid-template-columns: repeat(auto-fit, minmax(300px, 1fr)); gap: var(--space-4); margin-bottom: var(--space-4); }
.card { background: var(--color-bg-soft); border-radius: var(--radius-l); padding: var(--space-4); display: grid; gap: var(--space-3); align-content: start; }
.card.wide { margin-bottom: var(--space-4); }
.card-head { display: flex; justify-content: space-between; align-items: center; }
.row { display: flex; gap: var(--space-2); align-items: center; }
.row label { min-width: 110px; font-size: var(--font-size-body-s); color: var(--color-ink-muted); font-family: monospace; }
.field-row { display: grid; gap: var(--space-1); }
.field-row .hint { margin: 0 0 0 118px; }
.row.wrap { flex-wrap: wrap; }
.scopes { max-height: 160px; overflow: auto; }
.grow { flex: 1; }
input, select.bool { font: inherit; border: 1px solid var(--color-bg-line); border-radius: var(--radius-s); padding: var(--space-2) var(--space-3); background: var(--color-bg); color: var(--color-ink); flex: 1; min-width: 0; }
.num { width: 70px; flex: none; }
.check { display: flex; gap: var(--space-1); align-items: center; font-size: var(--font-size-body-s); }
.check input { flex: none; width: auto; }
.actions { display: flex; gap: var(--space-2); }
.primary { font: inherit; font-weight: 800; border: none; background: var(--color-sun); color: var(--color-ink); border-radius: var(--radius-pill); padding: var(--space-2) var(--space-4); cursor: pointer; justify-self: start; }
.primary:disabled { opacity: 0.5; }
.chip { font: inherit; font-size: var(--font-size-body-s); font-weight: 700; border: 1px solid var(--color-bg-line); background: transparent; color: var(--color-ink-muted); border-radius: var(--radius-pill); padding: 2px var(--space-3); cursor: pointer; }
.chip.danger { color: var(--color-coral-ink); }
.badge { font-size: var(--font-size-body-s); font-weight: 700; border-radius: var(--radius-pill); padding: 2px var(--space-3); background: var(--color-bg-line-soft); }
.badge.connected, .badge.delivered { background: var(--color-teal); color: var(--color-teal-deep); }
.badge.failing, .badge.failed { background: var(--color-coral); color: var(--color-coral-deep); }
.badge.pending { background: var(--color-sun); color: var(--color-sun-ink); }
.fail { color: var(--color-coral-ink); margin: 0; font-size: var(--font-size-body-s); }
.secret { background: var(--color-sun); color: var(--color-sun-ink); border-radius: var(--radius-m); padding: var(--space-3); margin: 0; font-size: var(--font-size-body-s); word-break: break-all; }
.table { width: 100%; border-collapse: collapse; }
th { text-align: left; font-size: var(--font-size-body-s); color: var(--color-ink-muted); padding: var(--space-1) var(--space-2); border-bottom: 1px solid var(--color-bg-line); }
td { padding: var(--space-2); border-bottom: 1px solid var(--color-bg-line-soft); }
.dim { opacity: 0.5; }
.acts { display: flex; gap: var(--space-1); }
.teal { color: var(--color-teal-ink); font-weight: 700; }
.coral { color: var(--color-coral-ink); font-weight: 700; }
.sub { font-size: var(--font-size-body-s); color: var(--color-ink-faint); margin: 0; }
.error { color: var(--color-coral-ink); }
.notice { color: var(--color-teal-ink); }
.modal-backdrop { position: fixed; inset: 0; background: rgb(12 15 20 / 40%); display: grid; place-items: center; padding: var(--space-4); }
.modal { background: var(--color-bg-soft); border-radius: var(--radius-xl); padding: var(--space-5); width: min(720px, 100%); max-height: 85dvh; overflow: auto; display: grid; gap: var(--space-3); }
</style>
