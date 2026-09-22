<script setup lang="ts">
definePageMeta({ layout: 'learner' })
const { t } = useI18n()
const { api } = useApi()
const push = usePush()
interface Pref { code: string, enabled: boolean, channel: string | null, isMandatory: boolean, group: 'learning' | 'assessment' | 'reminders' | 'hub' | 'other' }
const prefs = ref<Pref[]>([])
const error = ref('')
const notice = ref('')
const defaultChannel = ref<'telegram' | 'sms' | 'email' | 'push'>('telegram')
const GROUPS = ['learning', 'assessment', 'reminders', 'hub', 'other'] as const
async function load() { try { prefs.value = await api('/notifications/prefs') } catch (err) { error.value = apiErrorOf(err).message } }
onMounted(load)

// Push (докс/33 D-051): підписка цього браузера — окремо від переліку кодів вище
const pushSupported = push.isSupported()
const pushSubscribed = ref(false)
const pushBusy = ref(false)
onMounted(async () => {
  if (!pushSupported) return
  pushSubscribed.value = !!(await push.currentSubscription())
})
async function togglePush() {
  error.value = ''
  pushBusy.value = true
  try {
    if (pushSubscribed.value) { await push.unsubscribe(); pushSubscribed.value = false }
    else {
      const r = await push.subscribe()
      if (!r.ok) { error.value = r.error; return }
      pushSubscribed.value = true
    }
  }
  catch (err) { error.value = apiErrorOf(err).message }
  finally { pushBusy.value = false }
}
async function toggle(p: Pref) {
  error.value = ''
  try { await api('/notifications/prefs', { method: 'PATCH', body: { code: p.code, enabled: !p.enabled } }); p.enabled = !p.enabled }
  catch (err) { error.value = apiErrorOf(err).message }
}
async function test() { try { await api('/notifications/test', { method: 'POST' }); notice.value = t('notif.testSent') } catch (err) { error.value = apiErrorOf(err).message } }
async function setChannelAll() {
  try { for (const p of prefs.value) await api('/notifications/prefs', { method: 'PATCH', body: { code: p.code, channel: defaultChannel.value } }); notice.value = t('common.saved'); await load() }
  catch (err) { error.value = apiErrorOf(err).message }
}
const byGroup = (g: string) => prefs.value.filter(p => p.group === g)
</script>
<template>
  <div>
    <NuxtLink to="/learn/profile" class="back">← {{ t('learner.nav.profile') }}</NuxtLink>
    <h1>{{ t('notif.title') }}</h1>
    <p class="sub">{{ t('notif.hint') }}</p>
    <p v-if="error" class="error" role="alert">{{ error }}</p>
    <p v-if="notice" class="notice" role="status">{{ notice }}</p>
    <section v-for="g in GROUPS" :key="g" class="card">
      <h2>{{ t(`notif.group.${g}`) }}</h2>
      <label v-for="p in byGroup(g)" :key="p.code" :class="['row', { locked: p.isMandatory }]">
        <input type="checkbox" :checked="p.enabled || p.isMandatory" :disabled="p.isMandatory" @change="toggle(p)">
        <span class="name">{{ t(`notif.code.${p.code}`, p.code) }}</span>
        <span v-if="p.isMandatory" class="sub">🔒 {{ t('notif.mandatory') }}</span>
      </label>
      <p v-if="byGroup(g).length === 0" class="sub">—</p>
    </section>
    <section class="card">
      <h2>{{ t('notif.defaultChannel') }}</h2>
      <div class="row">
        <select v-model="defaultChannel" class="field"><option value="telegram">Telegram</option><option value="sms">SMS</option><option value="email">E-mail</option><option value="push">{{ t('notif.push.title') }}</option></select>
        <button class="chip" @click="setChannelAll">{{ t('common.save') }}</button>
        <button class="chip" @click="test">{{ t('notif.test') }}</button>
      </div>
    </section>
    <section v-if="pushSupported" class="card">
      <h2>{{ t('notif.push.title') }}</h2>
      <p class="sub">{{ t('notif.push.hint') }}</p>
      <div class="row">
        <button class="chip" :disabled="pushBusy" @click="togglePush">{{ pushSubscribed ? t('notif.push.disable') : t('notif.push.enable') }}</button>
        <span v-if="pushSubscribed" class="sub">✓ {{ t('notif.push.enabled') }}</span>
      </div>
    </section>
  </div>
</template>
<style scoped>
.back { color: var(--color-ink-muted); text-decoration: none; font-size: var(--font-size-body-s); }
h1 { margin: var(--space-2) 0 var(--space-1); font-weight: 900; }
h2 { margin: 0 0 var(--space-2); font-size: var(--font-size-body); color: var(--color-ink-muted); }
.card { background: var(--color-bg-soft); border-radius: var(--radius-m); padding: var(--space-3); margin-top: var(--space-3); display: grid; gap: var(--space-1); }
.row { display: flex; gap: var(--space-2); align-items: center; min-height: 44px; flex-wrap: wrap; }
.row.locked { opacity: 0.75; }
.name { flex: 1; min-width: 160px; }
.field { font: inherit; border: 1px solid var(--color-bg-line); border-radius: var(--radius-s); padding: var(--space-2); background: var(--color-bg); color: var(--color-ink); }
.chip { font: inherit; font-weight: 700; border: 1px solid var(--color-bg-line); background: transparent; color: var(--color-ink); border-radius: var(--radius-pill); padding: var(--space-1) var(--space-3); cursor: pointer; min-height: 44px; }
.sub { font-size: var(--font-size-body-s); color: var(--color-ink-faint); margin: 0; }
.error { color: var(--color-coral-ink); }
.notice { color: var(--color-teal-ink); }
</style>
