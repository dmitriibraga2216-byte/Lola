<script setup lang="ts">
definePageMeta({ layout: 'admin', middleware: 'admin-scope', requiredScope: 'settings.notifications' })
const { t } = useI18n()
const { api, apiRaw } = useApi()
const { hasScope } = useAuth()
interface Tpl { id: string, code: string, channel: string, locale: string, subject: string | null, body: string, isEnabled: boolean, buttons: { text: string, action: string }[], isMandatory: boolean, throttle: { maxPerDay?: number } | null, escalateAfterHours: number | null, ignoreQuietHours: boolean, version: number, updatedAt: string }
const tab = ref<'templates' | 'broadcast' | 'report'>('templates')
const defaults = ref<Record<string, string>>({})
const custom = ref<Tpl[]>([])
const error = ref('')
const notice = ref('')
const search = ref('')
const onlyChanged = ref(false)
const editing = ref<string | null>(null) // code
const form = reactive({ code: '', channel: 'telegram' as 'telegram' | 'sms' | 'email', locale: 'uk' as 'uk' | 'en', subject: '', body: '', isEnabled: true, isMandatory: false, maxPerDay: 0, escalateAfterHours: 0, ignoreQuietHours: false, buttons: [] as { text: string, action: string }[] })
const preview = ref('')
const variables = ref<string[]>([])
const versions = ref<{ version: number, body: string, createdAt: string, author: string | null }[]>([])
const people = ref<{ id: string, fullName: string }[]>([])
const previewUser = ref('')

async function load() {
  try { const r = await api<{ defaults: Record<string, string>, custom: Tpl[] }>('/settings/notifications'); defaults.value = r.defaults; custom.value = r.custom }
  catch (err) { error.value = apiErrorOf(err).message }
}
onMounted(async () => { load(); try { people.value = (await apiRaw<{ data: { id: string, fullName: string }[] }>('/people?limit=50')).data } catch { /* пусто */ } })
const codes = computed(() => Object.keys(defaults.value).filter(c => (!search.value || c.includes(search.value) || (defaults.value[c] ?? '').toLowerCase().includes(search.value.toLowerCase())) && (!onlyChanged.value || custom.value.some(x => x.code === c))))
const customOf = (code: string) => custom.value.find(x => x.code === code && x.channel === 'telegram' && x.locale === 'uk')
async function edit(code: string) {
  editing.value = code
  const c = customOf(code)
  Object.assign(form, { code, channel: 'telegram', locale: 'uk', subject: c?.subject ?? '', body: c?.body ?? defaults.value[code] ?? '', isEnabled: c?.isEnabled ?? true, isMandatory: c?.isMandatory ?? false, maxPerDay: c?.throttle?.maxPerDay ?? 0, escalateAfterHours: c?.escalateAfterHours ?? 0, ignoreQuietHours: c?.ignoreQuietHours ?? false, buttons: c?.buttons ? [...c.buttons] : [] })
  preview.value = ''
  versions.value = c ? await api<typeof versions.value>(`/settings/notifications/${c.id}/versions`).catch(() => []) : []
  await doPreview()
}
async function doPreview() {
  try { const r = await api<{ text: string, variables: string[] }>('/settings/notifications/preview', { method: 'POST', body: { body: form.body, code: form.code, userId: previewUser.value || undefined } }); preview.value = r.text; variables.value = r.variables }
  catch (err) { error.value = apiErrorOf(err).message }
}
function insertVar(v: string) { form.body += `{{${v}}}` }
async function save() {
  error.value = ''; notice.value = ''
  try {
    await api('/settings/notifications', { method: 'PUT', body: { code: form.code, channel: form.channel, locale: form.locale, subject: form.subject || undefined, body: form.body, isEnabled: form.isEnabled, isMandatory: form.isMandatory, throttle: form.maxPerDay ? { maxPerDay: form.maxPerDay } : null, escalateAfterHours: form.escalateAfterHours || null, ignoreQuietHours: form.ignoreQuietHours, buttons: form.buttons.filter(b => b.text && b.action) } })
    notice.value = t('common.saved'); await load(); await edit(form.code)
  }
  catch (err) { error.value = apiErrorOf(err).message }
}
async function resetDefault() {
  const c = customOf(form.code)
  if (!c || !confirm(t('ntpl.resetConfirm'))) return
  try { await api(`/settings/notifications/${c.id}`, { method: 'DELETE' }); notice.value = t('common.saved'); await load(); await edit(form.code) }
  catch (err) { error.value = apiErrorOf(err).message }
}
async function sendMe() { try { await api('/notifications/test', { method: 'POST' }); notice.value = t('notif.testSent') } catch (err) { error.value = apiErrorOf(err).message } }

// Рассылка (docs/23 §5.4)
const bc = reactive({ text: '', locationIds: [] as string[], positionIds: [] as string[], channel: '' as '' | 'telegram' | 'sms' | 'email' })
const locations = ref<{ id: string, name: string }[]>([])
const positions = ref<{ id: string, name: string }[]>([])
const bcPreview = ref<number | null>(null)
const bcResult = ref<{ recipients: number, queued: number } | null>(null)
watch(tab, async (v) => { if (v === 'broadcast' && !locations.value.length) { locations.value = await api<typeof locations.value>('/refs/locations').catch(() => []); positions.value = await api<typeof positions.value>('/refs/positions').catch(() => []) } if (v === 'report') loadReport() })
const audience = computed(() => ({ rules: [...(bc.locationIds.length ? [{ type: 'location', ids: bc.locationIds }] : []), ...(bc.positionIds.length ? [{ type: 'position', ids: bc.positionIds }] : [])], match: 'all' }))
async function countAudience() { try { const r = await api<{ count: number }>('/assignments/preview-audience', { method: 'POST', body: { audience: audience.value } }); bcPreview.value = r.count } catch (err) { error.value = apiErrorOf(err).message } }
async function sendBroadcast() {
  if (!audience.value.rules.length) { error.value = t('ntpl.pickAudience'); return }
  if (!confirm(t('ntpl.broadcastConfirm', { n: bcPreview.value ?? '?' }))) return
  try { bcResult.value = await api('/notifications/broadcast', { method: 'POST', body: { audience: audience.value, text: bc.text, channel: bc.channel || undefined } }); bc.text = '' }
  catch (err) { error.value = apiErrorOf(err).message }
}

// Отчёты (docs/23 §8)
const report = ref<{ delivery: Record<string, unknown>[], sms: Record<string, unknown>[], blocked: Record<string, unknown>[] } | null>(null)
async function loadReport() { try { report.value = await api('/reports/notifications') } catch (err) { error.value = apiErrorOf(err).message } }
</script>
<template>
  <div>
    <h1>{{ t('admin.nav.notifications') }}</h1>
    <div class="tabs" role="tablist">
      <button v-for="tb in (['templates', 'broadcast', 'report'] as const)" :key="tb" role="tab" :aria-selected="tab === tb" :class="['tab', { on: tab === tb }]" @click="tab = tb">{{ t(`ntpl.tab.${tb}`) }}</button>
    </div>
    <p v-if="error" class="error" role="alert">{{ error }}</p>
    <p v-if="notice" class="notice" role="status">{{ notice }}</p>

    <div v-if="tab === 'templates'" class="split">
      <section class="card">
        <div class="row"><input v-model="search" class="field grow" :placeholder="t('ntpl.search')"><label class="check"><input v-model="onlyChanged" type="checkbox"> {{ t('ntpl.onlyChanged') }}</label></div>
        <table class="table">
          <thead><tr><th>{{ t('ntpl.code') }}</th><th>{{ t('ntpl.text') }}</th><th /></tr></thead>
          <tbody>
            <tr v-for="c in codes" :key="c" :class="{ on: editing === c }">
              <td><code>{{ c }}</code><div v-if="customOf(c)" class="sub">v{{ customOf(c)!.version }}<span v-if="!customOf(c)!.isEnabled"> · {{ t('common.deactivate') }}</span><span v-if="customOf(c)!.isMandatory"> · 🔒</span></div></td>
              <td class="sub tpl">{{ customOf(c)?.body ?? defaults[c] }}</td>
              <td><button class="chip" @click="edit(c)">{{ t('common.edit') }}</button></td>
            </tr>
          </tbody>
        </table>
      </section>
      <aside v-if="editing" class="card editor">
        <h2><code>{{ form.code }}</code></h2>
        <div class="row">
          <select v-model="form.channel" class="field"><option value="telegram">Telegram</option><option value="sms">SMS</option><option value="email">E-mail</option></select>
          <select v-model="form.locale" class="field"><option value="uk">uk</option><option value="en">en</option></select>
        </div>
        <input v-if="form.channel === 'email'" v-model="form.subject" class="field" :placeholder="t('ntpl.subject')">
        <textarea v-model="form.body" class="field" rows="5" maxlength="2000" @input="doPreview" />
        <div class="vars"><button v-for="v in variables" :key="v" class="chip small" @click="insertVar(v)">{{ v }}</button></div>
        <div class="row"><select v-model="previewUser" class="field" @change="doPreview"><option value="">{{ t('ntpl.previewMe') }}</option><option v-for="p in people" :key="p.id" :value="p.id">{{ p.fullName }}</option></select></div>
        <div class="preview"><span class="sub">{{ t('ntpl.preview') }}</span><p>{{ preview }}</p></div>
        <label class="check"><input v-model="form.isEnabled" type="checkbox"> {{ t('ntpl.enabled') }}</label>
        <label class="check"><input v-model="form.isMandatory" type="checkbox"> {{ t('ntpl.mandatory') }}</label>
        <label class="check"><input v-model="form.ignoreQuietHours" type="checkbox"> {{ t('ntpl.ignoreQuiet') }}</label>
        <div class="row">
          <label class="sub">{{ t('ntpl.maxPerDay') }} <input v-model.number="form.maxPerDay" class="field short" type="number" min="0" max="50"></label>
          <label class="sub">{{ t('ntpl.escalate') }} <input v-model.number="form.escalateAfterHours" class="field short" type="number" min="0" max="720"></label>
        </div>
        <div class="sub">{{ t('ntpl.buttons') }}</div>
        <div v-for="(b, i) in form.buttons" :key="i" class="row"><input v-model="b.text" class="field" :placeholder="t('ntpl.btnText')" maxlength="40"><input v-model="b.action" class="field grow" :placeholder="t('ntpl.btnAction')"><button class="chip" @click="form.buttons.splice(i, 1)">×</button></div>
        <button v-if="form.buttons.length < 2" class="chip" @click="form.buttons.push({ text: '', action: '' })">+ {{ t('ntpl.button') }}</button>
        <div class="row">
          <button class="primary" :disabled="!form.body.trim()" @click="save">{{ t('common.save') }}</button>
          <button class="chip" @click="sendMe">{{ t('ntpl.sendMe') }}</button>
          <button v-if="customOf(form.code)" class="chip" @click="resetDefault">{{ t('ntpl.reset') }}</button>
        </div>
        <details v-if="versions.length" class="revs"><summary>{{ t('ntpl.versions', { n: versions.length }) }}</summary>
          <ul><li v-for="v in versions" :key="v.version"><b>v{{ v.version }}</b> · {{ new Date(v.createdAt).toLocaleString('uk') }} · {{ v.author ?? '—' }}<div class="sub tpl">{{ v.body }}</div></li></ul>
        </details>
      </aside>
    </div>

    <section v-else-if="tab === 'broadcast'" class="card editor">
      <h2>{{ t('ntpl.tab.broadcast') }}</h2>
      <p class="sub">{{ t('ntpl.broadcastHint') }}</p>
      <div class="row two">
        <label>{{ t('person.location') }}<select v-model="bc.locationIds" multiple size="4" class="field"><option v-for="l in locations" :key="l.id" :value="l.id">{{ l.name }}</option></select></label>
        <label>{{ t('person.position') }}<select v-model="bc.positionIds" multiple size="4" class="field"><option v-for="p in positions" :key="p.id" :value="p.id">{{ p.name }}</option></select></label>
      </div>
      <textarea v-model="bc.text" class="field" rows="4" maxlength="500" :placeholder="t('ntpl.broadcastText')" />
      <div class="row">
        <select v-model="bc.channel" class="field"><option value="">{{ t('ntpl.channelAuto') }}</option><option value="telegram">Telegram</option><option value="sms">SMS</option><option value="email">E-mail</option></select>
        <button class="chip" @click="countAudience">{{ t('ntpl.countAudience') }}</button>
        <span v-if="bcPreview != null" class="sub">{{ t('ntpl.recipients', { n: bcPreview }) }}</span>
        <button class="primary" :disabled="bc.text.trim().length < 3 || !hasScope('assignment.create')" @click="sendBroadcast">{{ t('ntpl.send') }}</button>
      </div>
      <p class="sub warn">{{ t('ntpl.quietWarn') }}</p>
      <p v-if="bcResult" class="notice">{{ t('ntpl.broadcastDone', bcResult) }}</p>
    </section>

    <section v-else class="card">
      <h2>{{ t('ntpl.tab.report') }}</h2>
      <template v-if="report">
        <h3>{{ t('ntpl.delivery') }}</h3>
        <div class="table-wrap"><table class="table"><thead><tr><th>{{ t('ntpl.code') }}</th><th>{{ t('ntpl.channel') }}</th><th>{{ t('ntpl.total') }}</th><th>{{ t('ntpl.sent') }}</th><th>{{ t('ntpl.failed') }}</th><th>{{ t('ntpl.skipped') }}</th><th>{{ t('ntpl.reacted') }}</th><th>{{ t('ntpl.avgReact') }}</th></tr></thead>
          <tbody><tr v-for="(r, i) in report.delivery" :key="i"><td><code>{{ r.code }}</code></td><td>{{ r.channel }}</td><td>{{ r.total }}</td><td class="teal">{{ r.sent }}</td><td class="coral">{{ r.failed }}</td><td>{{ r.skipped }} <span class="sub">{{ r.skip_reasons ? Object.keys(r.skip_reasons as object).join(', ') : '' }}</span></td><td>{{ r.reacted }}</td><td>{{ r.avg_minutes_to_react ?? '—' }}</td></tr></tbody></table></div>
        <h3>{{ t('ntpl.smsCosts') }}</h3>
        <table class="table"><thead><tr><th>{{ t('person.location') }}</th><th>{{ t('ntpl.messages') }}</th><th>{{ t('ntpl.segments') }}</th></tr></thead><tbody><tr v-for="(r, i) in report.sms" :key="i"><td>{{ r.location }}</td><td>{{ r.messages }}</td><td>{{ r.segments }}</td></tr><tr v-if="!report.sms.length"><td colspan="3" class="sub">—</td></tr></tbody></table>
        <h3>{{ t('ntpl.blockedBots') }}</h3>
        <ul class="list"><li v-for="b in report.blocked" :key="String(b.id)"><NuxtLink :to="`/admin/people/${b.id}`" class="link">{{ b.full_name }}</NuxtLink> <span class="sub">{{ b.location ?? '' }}</span></li><li v-if="!report.blocked.length" class="sub">—</li></ul>
      </template>
    </section>
  </div>
</template>
<style scoped>
h1 { margin: 0 0 var(--space-3); font-weight: 900; }
h2 { margin: 0 0 var(--space-2); font-size: var(--font-size-body); font-weight: 800; }
h3 { margin: var(--space-3) 0 var(--space-1); font-size: var(--font-size-body); color: var(--color-ink-muted); }
.tabs { display: flex; gap: var(--space-2); margin-bottom: var(--space-3); flex-wrap: wrap; }
.tab { font: inherit; font-weight: 700; border: 1px solid var(--color-bg-line); background: transparent; color: var(--color-ink-muted); border-radius: var(--radius-pill); padding: var(--space-1) var(--space-4); cursor: pointer; }
.tab.on { background: var(--color-ink); border-color: var(--color-ink); color: var(--color-bg-soft); }
.split { display: grid; grid-template-columns: minmax(0, 1fr) minmax(300px, 420px); gap: var(--space-3); align-items: start; }
@media (max-width: 900px) { .split { grid-template-columns: 1fr; } }
.card { background: var(--color-bg-soft); border-radius: var(--radius-m); padding: var(--space-3); min-width: 0; }
.editor { display: grid; gap: var(--space-2); }
.row { display: flex; gap: var(--space-2); align-items: center; flex-wrap: wrap; }
.row.two label { display: grid; gap: var(--space-1); font-size: var(--font-size-body-s); color: var(--color-ink-muted); flex: 1; min-width: 160px; }
.grow { flex: 1; min-width: 120px; }
.short { width: 80px; }
.field { font: inherit; border: 1px solid var(--color-bg-line); border-radius: var(--radius-s); padding: var(--space-2); background: var(--color-bg); color: var(--color-ink); min-width: 0; box-sizing: border-box; }
textarea.field { width: 100%; }
.check { display: flex; gap: var(--space-2); align-items: center; font-size: var(--font-size-body-s); }
.table { width: 100%; border-collapse: collapse; }
th { text-align: left; font-size: var(--font-size-body-s); color: var(--color-ink-muted); padding: var(--space-1) var(--space-2); border-bottom: 1px solid var(--color-bg-line); }
td { padding: var(--space-1) var(--space-2); border-bottom: 1px solid var(--color-bg-line-soft); vertical-align: top; }
tr.on td { background: var(--color-bg); }
.tpl { max-width: 420px; overflow: hidden; text-overflow: ellipsis; white-space: nowrap; }
.table-wrap { overflow-x: auto; }
.vars { display: flex; gap: var(--space-1); flex-wrap: wrap; }
.chip { font: inherit; font-size: var(--font-size-body-s); font-weight: 700; border: 1px solid var(--color-bg-line); background: transparent; color: var(--color-ink-muted); border-radius: var(--radius-pill); padding: var(--space-1) var(--space-3); cursor: pointer; }
.chip.small { padding: 0 var(--space-2); font-family: ui-monospace, monospace; }
.primary { font: inherit; font-weight: 800; border: none; background: var(--color-sun); color: var(--color-ink); border-radius: var(--radius-pill); padding: var(--space-2) var(--space-4); cursor: pointer; }
.primary:disabled { opacity: 0.5; }
.preview { background: var(--color-bg); border-radius: var(--radius-m); padding: var(--space-2) var(--space-3); }
.preview p { margin: 0; white-space: pre-wrap; }
.revs { font-size: var(--font-size-body-s); }
.revs summary { cursor: pointer; }
.list { list-style: none; margin: 0; padding: 0; display: grid; gap: var(--space-1); }
.link { color: var(--color-ink); font-weight: 700; text-decoration: none; }
.sub { font-size: var(--font-size-body-s); color: var(--color-ink-faint); }
.warn { color: var(--color-sun-ink); }
.teal { color: var(--color-teal-ink); }
.coral { color: var(--color-coral-ink); }
.error { color: var(--color-coral-ink); }
.notice { color: var(--color-teal-ink); }
</style>
