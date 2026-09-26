<script setup lang="ts">
/**
 * Консоль оператора → «Оператори» (docs/25 §7 п. 7): список, приглашение, смена роли, деактивация,
 * сброс второго фактора. Управляет только `owner` — остальные видят список; право проверяет сервер,
 * здесь кнопки только прячутся. Последнего владельца и себя сервер менять не даст — текст отказа
 * показывается как есть.
 */
definePageMeta({ layout: 'ops', middleware: 'ops-auth' })
const { t } = useI18n()
const { formatShortDate } = useFormat()
const { me, ops, can } = useOps()

const ROLES = ['owner', 'admin', 'billing', 'support', 'viewer'] as const
interface Operator { id: string, email: string, fullName: string, role: typeof ROLES[number], isActive: boolean, twoFactor: boolean, invitePending: boolean, lastLoginAt: string | null }

const list = ref<Operator[]>([])
const error = ref('')
const notice = ref('')
const busy = ref(false)
const invite = reactive({ email: '', fullName: '', role: 'viewer' as typeof ROLES[number] })
const inviteUrl = ref('')
const resetFor = ref<Operator | null>(null)
const resetReason = ref('')
const manage = computed(() => can('operators.manage'))

async function load() {
  try { list.value = await ops<Operator[]>('/operators') }
  catch (err) { error.value = apiErrorOf(err).message }
}
onMounted(load)

async function run(fn: () => Promise<void>) {
  if (busy.value) return
  error.value = ''
  notice.value = ''
  busy.value = true
  try { await fn(); await load() }
  catch (err) { error.value = apiErrorOf(err).message }
  finally { busy.value = false }
}

const sendInvite = () => run(async () => {
  const r = await ops<{ emailSent: boolean, inviteUrl: string | null }>('/operators', { method: 'POST', body: { ...invite, email: invite.email.trim(), fullName: invite.fullName.trim() } })
  inviteUrl.value = r.inviteUrl ?? ''
  notice.value = r.emailSent ? t('opsConsole.operators.invited', { email: invite.email }) : t('opsConsole.operators.invitedNoMail')
  Object.assign(invite, { email: '', fullName: '', role: 'viewer' })
})
const setRole = (o: Operator, role: string) => run(async () => {
  await ops(`/operators/${o.id}`, { method: 'PATCH', body: { role } })
  notice.value = t('opsConsole.operators.roleChanged', { name: o.fullName })
})
const setActive = (o: Operator, isActive: boolean) => run(async () => {
  await ops(`/operators/${o.id}`, { method: 'PATCH', body: { isActive } })
  notice.value = t(isActive ? 'opsConsole.operators.activated' : 'opsConsole.operators.deactivated', { name: o.fullName })
})
const reset = () => run(async () => {
  const o = resetFor.value!
  await ops(`/operators/${o.id}/two-factor-reset`, { method: 'POST', body: { reason: resetReason.value.trim() } })
  notice.value = t('opsConsole.operators.resetDone', { name: o.fullName })
  resetFor.value = null
  resetReason.value = ''
})
const fmt = (d: string | null) => d ? formatShortDate(new Date(d)) : '—'
</script>

<template>
  <section>
    <h1 class="title">{{ t('opsConsole.nav.operators') }}</h1>
    <p v-if="error" class="error-text" role="alert">{{ error }}</p>
    <p v-if="notice" class="note" role="status">{{ notice }}</p>
    <p v-if="inviteUrl" class="card link-box">{{ t('opsConsole.operators.linkHint') }} <code>{{ inviteUrl }}</code></p>

    <form v-if="manage" class="card invite" @submit.prevent="sendInvite">
      <h2>{{ t('opsConsole.operators.invite') }}</h2>
      <div class="row">
        <div><label class="label" for="op-email">{{ t('opsConsole.login.email') }}</label><input id="op-email" v-model="invite.email" class="field" type="email" required></div>
        <div><label class="label" for="op-name">{{ t('opsConsole.operators.fullName') }}</label><input id="op-name" v-model="invite.fullName" class="field" required></div>
        <div>
          <label class="label" for="op-role">{{ t('opsConsole.operators.role') }}</label>
          <select id="op-role" v-model="invite.role" class="field"><option v-for="r in ROLES" :key="r" :value="r">{{ t(`opsConsole.roles.${r}`) }}</option></select>
        </div>
      </div>
      <p class="muted small">{{ t(`opsConsole.roleHints.${invite.role}`) }}</p>
      <button type="submit" class="btn primary" :disabled="busy || !invite.email || invite.fullName.trim().length < 2">{{ t('opsConsole.operators.send') }}</button>
    </form>

    <div class="table-wrap">
      <table class="table" data-testid="ops-operators">
        <thead>
          <tr><th>{{ t('opsConsole.operators.fullName') }}</th><th>{{ t('opsConsole.operators.role') }}</th><th>{{ t('opsConsole.operators.state') }}</th><th>{{ t('opsConsole.operators.lastLogin') }}</th><th v-if="manage" /></tr>
        </thead>
        <tbody>
          <tr v-for="o in list" :key="o.id">
            <td><b>{{ o.fullName }}</b><span class="sub">{{ o.email }}</span></td>
            <td>
              <select v-if="manage && o.id !== me?.adminId" class="field" :value="o.role" :aria-label="t('opsConsole.operators.role')" :disabled="busy" @change="setRole(o, ($event.target as HTMLSelectElement).value)">
                <option v-for="r in ROLES" :key="r" :value="r">{{ t(`opsConsole.roles.${r}`) }}</option>
              </select>
              <span v-else class="badge">{{ t(`opsConsole.roles.${o.role}`) }}</span>
            </td>
            <td class="chips">
              <span class="badge" :class="o.isActive ? 'teal' : 'muted'">{{ t(o.isActive ? 'opsConsole.operators.active' : 'opsConsole.operators.inactive') }}</span>
              <span v-if="o.invitePending" class="badge sun">{{ t('opsConsole.operators.pending') }}</span>
              <span v-else class="badge" :class="o.twoFactor ? 'teal' : 'coral'">{{ t(o.twoFactor ? 'opsConsole.operators.tfOn' : 'opsConsole.operators.tfOff') }}</span>
            </td>
            <td>{{ fmt(o.lastLoginAt) }}</td>
            <td v-if="manage" class="actions">
              <template v-if="o.id !== me?.adminId">
                <button type="button" class="btn ghost small" :disabled="busy" @click="setActive(o, !o.isActive)">{{ t(o.isActive ? 'opsConsole.operators.deactivate' : 'opsConsole.operators.activate') }}</button>
                <button v-if="o.twoFactor && can('operators.two_factor_reset')" type="button" class="btn ghost small" :disabled="busy" @click="resetFor = o; resetReason = ''">{{ t('opsConsole.operators.reset') }}</button>
              </template>
            </td>
          </tr>
        </tbody>
      </table>
    </div>

    <form v-if="resetFor" class="card reset" role="dialog" :aria-label="t('opsConsole.operators.reset')" @submit.prevent="reset">
      <h2>{{ t('opsConsole.operators.resetTitle', { name: resetFor.fullName }) }}</h2>
      <p class="muted small">{{ t('opsConsole.operators.resetHint') }}</p>
      <label class="label" for="op-reason">{{ t('opsConsole.operators.reason') }}</label>
      <textarea id="op-reason" v-model="resetReason" class="field" rows="3" maxlength="500" />
      <div class="chips">
        <button type="button" class="btn ghost" @click="resetFor = null">{{ t('common.cancel') }}</button>
        <button type="submit" class="btn danger" :disabled="busy || resetReason.trim().length < 10">{{ t('opsConsole.operators.reset') }}</button>
      </div>
    </form>
  </section>
</template>

<style scoped>
.title { margin: 0 0 var(--space-4); font-size: var(--font-size-title-l); font-weight: 900; }
h2 { margin: 0 0 var(--space-3); font-size: var(--font-size-body); font-weight: 900; }
.invite, .reset, .link-box { margin-bottom: var(--space-4); display: grid; gap: var(--space-2); }
.row { display: grid; grid-template-columns: repeat(auto-fit, minmax(180px, 1fr)); gap: var(--space-2); }
.small { font-size: var(--font-size-body-s); }
.invite .btn { justify-self: start; }
.link-box code { overflow-wrap: anywhere; }
.actions { display: flex; flex-wrap: wrap; gap: var(--space-2); }
</style>
