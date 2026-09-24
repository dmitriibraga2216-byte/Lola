<script setup lang="ts">
const { formatDateTime, formatShortDate } = useFormat()
definePageMeta({ layout: 'admin', middleware: 'admin-scope', requiredScope: 'settings.notifications' })
const { t } = useI18n()
const { api, apiRaw } = useApi()
const { hasScope } = useAuth()
interface Tpl { id: string, code: string, channel: string, locale: string, subject: string | null, body: string, bodyMjml: string | null, imageKey: string | null, telegramImageKey: string | null, isEnabled: boolean, buttons: { text: string, action: string }[], isMandatory: boolean, throttle: { maxPerDay?: number } | null, escalateAfterHours: number | null, ignoreQuietHours: boolean, version: number, updatedAt: string }
const tab = ref<'templates' | 'broadcast' | 'report' | 'schedule'>('templates')
const defaults = ref<Record<string, string>>({})
// docs/23 §13.1 (докс/31 залишок «NotificationTemplates»): дефолтний стан тумблерів Email/Telegram,
// поки тенант не перевизначив канал своїм рядком
const defaultChannels = ref<Record<string, { telegram: boolean, email: boolean, inapp: boolean }>>({})
const custom = ref<Tpl[]>([])
const error = ref('')
const notice = ref('')
const search = ref('')
const onlyChanged = ref(false)
const editing = ref<string | null>(null) // code
const editorTab = ref<'global' | 'custom'>('custom')
const form = reactive({ code: '', channel: 'telegram' as 'telegram' | 'sms' | 'email', locale: 'uk' as 'uk' | 'en' | 'ru', subject: '', body: '', bodyMjml: '', imageKey: '', telegramImageKey: '', isEnabled: true, isMandatory: false, maxPerDay: 0, escalateAfterHours: 0, ignoreQuietHours: false, buttons: [] as { text: string, action: string }[] })
const preview = ref('')
const previewHtml = ref<string | null>(null)
const variables = ref<string[]>([])
// scope (docs/23 §13.1): «Глобальний» — код без рядка в БД, «Кастомний» — тенант перевизначив
// хоча б один канал (мокап NotificationTemplates: чипи Глобальні/Кастомні, колонки E-mail/Telegram)
const overridesOf = (code: string) => custom.value.filter(x => x.code === code && x.locale === 'uk')
const channelOf = (code: string, channel: string) => overridesOf(code).find(x => x.channel === channel)
const scopeOf = (code: string) => overridesOf(code).length ? 'custom' : 'global'
const lastChanged = (code: string) => overridesOf(code).map(x => x.updatedAt).sort().at(-1) ?? null
const fmtDate = (d: string) => formatShortDate(new Date(d))
const scopeCounts = computed(() => ({ global: Object.keys(defaults.value).filter(c => scopeOf(c) === 'global').length, custom: Object.keys(defaults.value).filter(c => scopeOf(c) === 'custom').length }))
const scopeFilter = ref<'all' | 'global' | 'custom'>('all')
const versions = ref<{ version: number, body: string, createdAt: string, author: string | null }[]>([])
const people = ref<{ id: string, fullName: string }[]>([])
const previewUser = ref('')

async function load() {
  try {
    const r = await api<{ defaults: Record<string, string>, defaultChannels: typeof defaultChannels.value, custom: Tpl[] }>('/settings/notifications')
    defaults.value = r.defaults; defaultChannels.value = r.defaultChannels ?? {}; custom.value = r.custom
  }
  catch (err) { error.value = apiErrorOf(err).message }
}
// Стан пілюлі Email/Telegram: кастомний оверрайд каналу, якщо є, інакше — дефолт коду (докс/31 залишок)
const channelPill = (code: string, channel: 'email' | 'telegram') => {
  const c = channelOf(code, channel)
  return { on: c ? c.isEnabled : (defaultChannels.value[code]?.[channel] ?? false), isDefault: !c }
}
/** Клік по пілюлі: перемикає канал — без кастому створює перевизначення з тексту за замовчуванням (мокап: тумблери клікабельні). */
async function toggleChannel(code: string, channel: 'email' | 'telegram') {
  error.value = ''
  const c = channelOf(code, channel)
  const nextEnabled = c ? !c.isEnabled : !(defaultChannels.value[code]?.[channel] ?? false)
  const body = c?.body ?? defaults.value[code]
  if (!body) return
  try {
    await api('/settings/notifications', {
      method: 'PUT',
      body: {
        code, channel, locale: 'uk', subject: c?.subject || undefined, body,
        bodyMjml: channel === 'email' ? (c?.bodyMjml || undefined) : undefined,
        imageKey: c?.imageKey ?? null, telegramImageKey: c?.telegramImageKey ?? null,
        isEnabled: nextEnabled, isMandatory: c?.isMandatory ?? false,
        throttle: c?.throttle ?? null, escalateAfterHours: c?.escalateAfterHours ?? null,
        ignoreQuietHours: c?.ignoreQuietHours ?? false, buttons: c?.buttons ?? [],
      },
    })
    await load()
  }
  catch (err) { error.value = apiErrorOf(err).message }
}
onMounted(async () => { load(); try { people.value = (await apiRaw<{ data: { id: string, fullName: string }[] }>('/people?limit=50')).data } catch { /* пусто */ } })
const codes = computed(() => Object.keys(defaults.value).filter(c => (!search.value || c.includes(search.value) || (defaults.value[c] ?? '').toLowerCase().includes(search.value.toLowerCase())) && (!onlyChanged.value || custom.value.some(x => x.code === c)) && (scopeFilter.value === 'all' || scopeOf(c) === scopeFilter.value)))
const customOf = (code: string) => custom.value.find(x => x.code === code && x.channel === 'telegram' && x.locale === 'uk')
async function edit(code: string) {
  editing.value = code
  editorTab.value = 'custom'
  const c = customOf(code)
  Object.assign(form, { code, channel: 'telegram', locale: 'uk', subject: c?.subject ?? '', body: c?.body ?? defaults.value[code] ?? '', bodyMjml: c?.bodyMjml ?? '', imageKey: c?.imageKey ?? '', telegramImageKey: c?.telegramImageKey ?? '', isEnabled: c?.isEnabled ?? true, isMandatory: c?.isMandatory ?? false, maxPerDay: c?.throttle?.maxPerDay ?? 0, escalateAfterHours: c?.escalateAfterHours ?? 0, ignoreQuietHours: c?.ignoreQuietHours ?? false, buttons: c?.buttons ? [...c.buttons] : [] })
  preview.value = ''
  previewHtml.value = null
  versions.value = c ? await api<typeof versions.value>(`/settings/notifications/${c.id}/versions`).catch(() => []) : []
  await doPreview()
}
async function doPreview() {
  try {
    const r = await api<{ text: string, html: string | null, variables: string[] }>('/settings/notifications/preview', { method: 'POST', body: { body: form.body, bodyMjml: form.channel === 'email' ? (form.bodyMjml || undefined) : undefined, code: form.code, locale: form.locale, userId: previewUser.value || undefined } })
    preview.value = r.text; previewHtml.value = r.html; variables.value = r.variables
  }
  catch (err) { error.value = apiErrorOf(err).message }
}
function insertVar(v: string) { form.body += `{{${v}}}` }
async function save() {
  error.value = ''; notice.value = ''
  try {
    await api('/settings/notifications', { method: 'PUT', body: { code: form.code, channel: form.channel, locale: form.locale, subject: form.subject || undefined, body: form.body, bodyMjml: form.channel === 'email' ? (form.bodyMjml || undefined) : undefined, imageKey: form.imageKey || null, telegramImageKey: form.telegramImageKey || null, isEnabled: form.isEnabled, isMandatory: form.isMandatory, throttle: form.maxPerDay ? { maxPerDay: form.maxPerDay } : null, escalateAfterHours: form.escalateAfterHours || null, ignoreQuietHours: form.ignoreQuietHours, buttons: form.buttons.filter(b => b.text && b.action) } })
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

// Час відправлення по класах подій + обвʼязка листа (docs/23 §13.2.1, §13.5)
interface Clock { hour: number, minute: number }
const SCHEDULE_CLASSES = ['birthdays', 'anniversaries', 'autoClosedTasks', 'managerDigest', 'dueTasks', 'programReminder'] as const
const quietHours = reactive({ enabled: true, from: 9, to: 20 })
const schedule = reactive<Record<typeof SCHEDULE_CLASSES[number], Clock>>({
  birthdays: { hour: 9, minute: 0 }, anniversaries: { hour: 9, minute: 0 }, autoClosedTasks: { hour: 0, minute: 0 },
  managerDigest: { hour: 9, minute: 0 }, dueTasks: { hour: 9, minute: 0 }, programReminder: { hour: 9, minute: 0 },
})
const emailLayout = reactive({ headerMjml: '', footerMjml: '', logoKey: '' })
async function loadSchedule() {
  try {
    const r = await api<{ quietHours: typeof quietHours, schedule: typeof schedule }>('/settings/notification-schedule')
    Object.assign(quietHours, r.quietHours); Object.assign(schedule, r.schedule)
    const l = await api<{ headerMjml: string, footerMjml: string, logoKey: string | null }>('/settings/email-layout')
    Object.assign(emailLayout, { headerMjml: l.headerMjml, footerMjml: l.footerMjml, logoKey: l.logoKey ?? '' })
  }
  catch (err) { error.value = apiErrorOf(err).message }
}
async function saveSchedule() {
  error.value = ''; notice.value = ''
  try {
    await api('/settings/notification-schedule', { method: 'PUT', body: { quietHours: { ...quietHours }, schedule: { ...schedule } } })
    await api('/settings/email-layout', { method: 'PUT', body: { headerMjml: emailLayout.headerMjml, footerMjml: emailLayout.footerMjml, logoKey: emailLayout.logoKey || null } })
    notice.value = t('common.saved')
  }
  catch (err) { error.value = apiErrorOf(err).message }
}
watch(tab, (v) => { if (v === 'schedule') loadSchedule() })
</script>
<template>
  <div>
    <h1>{{ t('admin.nav.notifications') }}</h1>
    <div class="tabs" role="tablist">
      <button v-for="tb in (['templates', 'broadcast', 'report', 'schedule'] as const)" :key="tb" role="tab" :aria-selected="tab === tb" :class="['tab', { on: tab === tb }]" @click="tab = tb">{{ t(`ntpl.tab.${tb}`) }}</button>
    </div>
    <p v-if="error" class="error" role="alert">{{ error }}</p>
    <p v-if="notice" class="notice" role="status">{{ notice }}</p>

    <div v-if="tab === 'templates'" class="split">
      <section class="card">
        <p class="sub">{{ t('ntpl.scopeHint') }}</p>
        <div class="chips" role="group">
          <button type="button" :class="['chip', { on: scopeFilter === 'all' }]" @click="scopeFilter = 'all'">{{ t('ntpl.scopePlural.all') }}</button>
          <button type="button" :class="['chip', { on: scopeFilter === 'global' }]" @click="scopeFilter = 'global'">{{ t('ntpl.scopePlural.global') }} · {{ scopeCounts.global }}</button>
          <button type="button" :class="['chip', { on: scopeFilter === 'custom' }]" @click="scopeFilter = 'custom'">{{ t('ntpl.scopePlural.custom') }} · {{ scopeCounts.custom }}</button>
        </div>
        <div class="row"><input v-model="search" class="field grow" :placeholder="t('ntpl.search')"><label class="check"><input v-model="onlyChanged" type="checkbox"> {{ t('ntpl.onlyChanged') }}</label></div>
        <table class="table">
          <thead><tr><th>{{ t('ntpl.code') }}</th><th>{{ t('ntpl.col.email') }}</th><th>{{ t('ntpl.col.telegram') }}</th><th>{{ t('ntpl.scopeCol') }}</th><th>{{ t('ntpl.col.updated') }}</th><th /></tr></thead>
          <tbody>
            <tr v-for="c in codes" :key="c" :class="{ on: editing === c }">
              <td><code>{{ c }}</code><div v-if="customOf(c)" class="sub">v{{ customOf(c)!.version }}<span v-if="!customOf(c)!.isEnabled"> · {{ t('common.deactivate') }}</span><span v-if="customOf(c)!.isMandatory"> · 🔒</span></div></td>
              <td>
                <button type="button" class="pill-btn" :title="t('ntpl.toggleChannel')" @click="toggleChannel(c, 'email')">
                  <span :class="['pill', channelPill(c, 'email').on ? 'on' : 'off', { default: channelPill(c, 'email').isDefault }]">{{ channelPill(c, 'email').on ? t('ntpl.enabled') : t('ntpl.disabled') }}</span>
                </button>
              </td>
              <td>
                <button type="button" class="pill-btn" :title="t('ntpl.toggleChannel')" @click="toggleChannel(c, 'telegram')">
                  <span :class="['pill', channelPill(c, 'telegram').on ? 'on' : 'off', { default: channelPill(c, 'telegram').isDefault }]">{{ channelPill(c, 'telegram').on ? t('ntpl.enabled') : t('ntpl.disabled') }}</span>
                </button>
              </td>
              <td><span :class="['badge', scopeOf(c)]">{{ t(`ntpl.scope.${scopeOf(c)}`) }}</span></td>
              <td class="muted">{{ lastChanged(c) ? fmtDate(lastChanged(c)!) : '—' }}</td>
              <td><button class="chip" @click="edit(c)">{{ t('common.edit') }}</button></td>
            </tr>
          </tbody>
        </table>
      </section>
      <aside v-if="editing" class="card editor">
        <h2><code>{{ form.code }}</code></h2>
        <div class="tabs" role="tablist">
          <button type="button" role="tab" :aria-selected="editorTab === 'global'" :class="['tab', { on: editorTab === 'global' }]" @click="editorTab = 'global'">{{ t('ntpl.scope.global') }}</button>
          <button type="button" role="tab" :aria-selected="editorTab === 'custom'" :class="['tab', { on: editorTab === 'custom' }]" @click="editorTab = 'custom'">{{ t('ntpl.scope.custom') }}</button>
        </div>

        <template v-if="editorTab === 'global'">
          <span class="sub">{{ t('ntpl.bodyHint') }}</span>
          <p class="preview tpl-readonly">{{ defaults[form.code] }}</p>
        </template>
        <template v-else>
          <div class="sub label">{{ t('ntpl.channels') }}</div>
          <div class="row">
            <select v-model="form.channel" class="field"><option value="telegram">Telegram</option><option value="sms">SMS</option><option value="email">E-mail</option></select>
            <select v-model="form.locale" class="field"><option value="uk">uk</option><option value="en">en</option><option value="ru">ru</option></select>
          </div>
          <input v-if="form.channel === 'email'" v-model="form.subject" class="field" :placeholder="t('ntpl.subject')">
          <span class="sub">{{ t('ntpl.bodyHint') }}</span>
          <textarea v-model="form.body" class="field" rows="5" maxlength="2000" @input="doPreview" />
          <template v-if="form.channel === 'email'">
            <span class="sub">{{ t('ntpl.mjml') }}</span>
            <textarea v-model="form.bodyMjml" class="field mono" rows="6" maxlength="20000" placeholder="<mj-text>{{user.first_name}}, …</mj-text>" @input="doPreview" />
            <div class="row"><input v-model="form.imageKey" class="field grow" :placeholder="t('ntpl.imageKey')"><input v-model="form.telegramImageKey" class="field grow" :placeholder="t('ntpl.telegramImageKey')"></div>
          </template>
          <div class="sub label">{{ t('ntpl.variables') }}</div>
          <p class="sub hint">{{ t('ntpl.variablesHint') }}</p>
          <div class="vars"><button v-for="v in variables" :key="v" class="chip small" @click="insertVar(v)">{{ v }}</button></div>
          <div class="row"><select v-model="previewUser" class="field" @change="doPreview"><option value="">{{ t('ntpl.previewMe') }}</option><option v-for="p in people" :key="p.id" :value="p.id">{{ p.fullName }}</option></select></div>
          <div class="preview"><span class="sub">{{ t('ntpl.preview') }}</span><p>{{ preview }}</p></div>
          <div v-if="previewHtml" class="preview"><span class="sub">{{ t('ntpl.previewHtml') }}</span><iframe class="html-preview" :srcdoc="previewHtml" /></div>
          <label class="check"><input v-model="form.isEnabled" type="checkbox"> {{ t('ntpl.enabled') }}</label>
          <label class="check"><input v-model="form.isMandatory" type="checkbox"> {{ t('ntpl.mandatory') }}</label>
          <div class="sub label">{{ t('ntpl.whenToSend') }}</div>
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
            <ul><li v-for="v in versions" :key="v.version"><b>v{{ v.version }}</b> · {{ formatDateTime(new Date(v.createdAt)) }} · {{ v.author ?? '—' }}<div class="sub tpl">{{ v.body }}</div></li></ul>
          </details>
        </template>
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

    <section v-else-if="tab === 'schedule'" class="card editor">
      <h2>{{ t('ntpl.schedule.title') }}</h2>
      <p class="sub warn">{{ t('ntpl.schedule.warn') }}</p>
      <label class="check"><input v-model="quietHours.enabled" type="checkbox"> {{ t('ntpl.schedule.limitPeriod') }}</label>
      <div v-if="quietHours.enabled" class="row">
        <label class="sub">{{ t('ntpl.schedule.from') }} <input v-model.number="quietHours.from" class="field short" type="number" min="0" max="23"></label>
        <label class="sub">{{ t('ntpl.schedule.to') }} <input v-model.number="quietHours.to" class="field short" type="number" min="1" max="24"></label>
      </div>
      <div v-for="cls in SCHEDULE_CLASSES" :key="cls" class="row">
        <span class="grow">{{ t(`ntpl.schedule.class.${cls}`) }}</span>
        <input v-model.number="schedule[cls].hour" class="field short" type="number" min="0" max="23">
        <input v-model.number="schedule[cls].minute" class="field short" type="number" min="0" max="59">
      </div>
      <h2>{{ t('ntpl.schedule.emailLayout') }}</h2>
      <span class="sub">{{ t('ntpl.schedule.header') }}</span>
      <textarea v-model="emailLayout.headerMjml" class="field mono" rows="4" maxlength="20000" />
      <span class="sub">{{ t('ntpl.schedule.footer') }}</span>
      <textarea v-model="emailLayout.footerMjml" class="field mono" rows="4" maxlength="20000" />
      <input v-model="emailLayout.logoKey" class="field" :placeholder="t('ntpl.schedule.logoKey')">
      <button class="primary" @click="saveSchedule">{{ t('common.save') }}</button>
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
.chips { display: flex; gap: var(--space-2); flex-wrap: wrap; margin-bottom: var(--space-2); }
.chip { font: inherit; font-size: var(--font-size-body-s); font-weight: 700; border: 1px solid var(--color-bg-line); background: transparent; color: var(--color-ink-muted); border-radius: var(--radius-pill); padding: var(--space-1) var(--space-3); cursor: pointer; }
.chip.small { padding: 0 var(--space-2); font-family: ui-monospace, monospace; }
.chip.on { background: var(--color-ink); border-color: var(--color-ink); color: var(--color-bg-soft); }
.pill-btn { font: inherit; border: none; background: transparent; padding: 0; cursor: pointer; }
.pill { display: inline-block; font-size: var(--font-size-body-s); font-weight: 700; border-radius: var(--radius-pill); padding: 2px var(--space-3); }
.pill.on { background: var(--color-teal); color: var(--color-teal-deep); }
.pill.off { background: var(--color-bg-line-soft); color: var(--color-ink-muted); }
.pill.default { opacity: 0.6; border: 1px dashed var(--color-bg-line); }
.primary { font: inherit; font-weight: 800; border: none; background: var(--color-sun); color: var(--color-ink); border-radius: var(--radius-pill); padding: var(--space-2) var(--space-4); cursor: pointer; }
.primary:disabled { opacity: 0.5; }
.preview { background: var(--color-bg); border-radius: var(--radius-m); padding: var(--space-2) var(--space-3); }
.preview p { margin: 0; white-space: pre-wrap; }
.tpl-readonly { margin: 0; white-space: pre-wrap; }
.label { font-weight: 800; margin-top: var(--space-2); }
.hint { margin: 0; }
.mono { font-family: ui-monospace, monospace; }
.html-preview { width: 100%; height: 240px; border: 1px solid var(--color-bg-line); border-radius: var(--radius-s); background: #fff; }
.badge { font-size: var(--font-size-body-s); font-weight: 700; border-radius: var(--radius-pill); padding: 2px var(--space-3); background: var(--color-bg-line-soft); }
.badge.global { background: var(--color-bg-line-soft); color: var(--color-ink-muted); }
.badge.custom { background: var(--color-teal); color: var(--color-teal-deep); }
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
