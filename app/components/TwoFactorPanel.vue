<script setup lang="ts">
/**
 * Блок «Двофакторна автентифікація» настроек компании (docs/24 §3.4, docs/v2/39 П-24.1).
 *
 * Три части: требование для администраторов (ключ политики `passwords.adminTwoFactor`,
 * сохраняется общей кнопкой «Зберегти» экрана), свой второй фактор («Мій вхід» — действует
 * сразу, это не настройка пространства, а вход человека) и список администраторов с тем,
 * подключили ли они фактор, — со сбросом для потерявшего телефон и коды.
 *
 * Включить требование можно только с подключённым своим фактором — сервер отвечает
 * `422 two_factor_enroll_first`, экран предупреждает заранее: так политика не запирает того,
 * кто её включил.
 */
const required = defineModel<boolean>({ required: true })
const { t } = useI18n()
const { api } = useApi()
const { me, hasScope } = useAuth()
const { formatDate } = useFormat()

interface Status { step: string | null, enrolled: boolean, required: boolean, confirmedAt: string | null, recoveryCodesLeft: number, setupPending: boolean }
interface Overview { required: boolean, admins: { userId: string, fullName: string, enrolled: boolean, confirmedAt: string | null }[] }

const status = ref<Status | null>(null)
const overview = ref<Overview | null>(null)
const error = ref('')
const notice = ref('')
const busy = ref(false)
/** Что открыто в «Мій вхід»: подключение, замена, перевыпуск кодов, отключение */
const action = ref<'' | 'enroll' | 'replace' | 'codes' | 'disable'>('')
const proof = ref('')
const freshCodes = ref<string[]>([])

async function load() {
  error.value = ''
  try {
    const [s, o] = await Promise.all([api<Status>('/auth/two-factor'), api<Overview>('/settings/two-factor')])
    status.value = s
    overview.value = o
  }
  catch (err) { error.value = apiErrorOf(err).message }
}
onMounted(load)

/** Код приложения — шесть цифр; всё остальное считаем резервным кодом. */
function proofBody(): Record<string, string> {
  const v = proof.value.trim()
  return /^\d{6}$/.test(v) ? { code: v } : { recoveryCode: v }
}

function failText(err: unknown): string {
  const e = apiErrorOf(err)
  const left = (e.details as { attemptsLeft?: number } | undefined)?.attemptsLeft
  return left !== undefined ? t('twoFactor.invalidLeft', { n: left }) : e.message
}

async function regenerate() {
  busy.value = true; error.value = ''
  try {
    freshCodes.value = (await api<{ recoveryCodes: string[] }>('/auth/two-factor/recovery-codes', { method: 'POST', body: proofBody() })).recoveryCodes
    proof.value = ''
    await load()
  }
  catch (err) { error.value = failText(err) }
  finally { busy.value = false }
}

async function disable() {
  busy.value = true; error.value = ''
  try {
    await api('/auth/two-factor', { method: 'DELETE', body: proofBody() })
    action.value = ''; proof.value = ''
    notice.value = t('twoFactor.disabled')
    await load()
  }
  catch (err) { error.value = failText(err) }
  finally { busy.value = false }
}

async function reset(userId: string, name: string) {
  if (!confirm(t('twoFactor.resetConfirm', { name }))) return
  error.value = ''
  try {
    await api(`/people/${userId}/two-factor`, { method: 'DELETE' })
    notice.value = t('twoFactor.resetDone', { name })
    await load()
  }
  catch (err) { error.value = apiErrorOf(err).message }
}

async function enrolled() {
  action.value = ''
  notice.value = t('twoFactor.enabledNow')
  await load()
}

/** Требование нельзя включить, пока свой фактор не подключён (выключить — всегда можно). */
const cannotRequire = computed(() => !required.value && !status.value?.enrolled)
</script>

<template>
  <div class="tf">
    <p v-if="error" class="error-text" role="alert">{{ error }}</p>
    <p v-if="notice" class="note teal" role="status">{{ notice }}</p>

    <label class="toggle row" :class="{ off: cannotRequire }">
      <input v-model="required" type="checkbox" :disabled="cannotRequire" data-testid="two-factor-required">
      <span>{{ t('twoFactor.requireAdmins') }}<span class="hint">{{ t('twoFactor.requireAdminsHint') }}</span></span>
    </label>
    <p v-if="cannotRequire" class="help">{{ t('twoFactor.enrollFirst') }}</p>

    <section class="block">
      <h3 class="block-title">{{ t('twoFactor.myLogin') }}</h3>
      <template v-if="status && !status.enrolled">
        <p class="help">{{ t('twoFactor.notEnrolled') }}</p>
        <TwoFactorEnroll v-if="action === 'enroll'" mode="enroll" @done="enrolled" />
        <button v-else class="btn primary" type="button" data-testid="two-factor-enroll" @click="action = 'enroll'; notice = ''">{{ t('twoFactor.enroll') }}</button>
      </template>
      <template v-else-if="status">
        <p class="help">
          <span class="badge teal">{{ t('twoFactor.on') }}</span>
          {{ t('twoFactor.since', { date: status.confirmedAt ? formatDate(status.confirmedAt) : '—' }) }} · {{ t('twoFactor.codesLeft', { n: status.recoveryCodesLeft }) }}
        </p>
        <TwoFactorEnroll v-if="action === 'replace'" mode="replace" @done="enrolled" @cancel="action = ''" />
        <div v-else-if="action === 'codes' || action === 'disable'" class="proof">
          <label class="label" for="tf-proof">{{ t('twoFactor.proof') }}</label>
          <input id="tf-proof" v-model="proof" class="field" autocomplete="one-time-code" maxlength="20" @keyup.enter="action === 'codes' ? regenerate() : disable()">
          <div class="row">
            <button v-if="action === 'codes'" class="btn primary" type="button" :disabled="busy || proof.trim().length < 6" @click="regenerate">{{ t('twoFactor.newCodes') }}</button>
            <button v-else class="btn danger" type="button" :disabled="busy || proof.trim().length < 6" @click="disable">{{ t('twoFactor.disable') }}</button>
            <button class="btn ghost" type="button" @click="action = ''; proof = ''; freshCodes = []">{{ t('common.cancel') }}</button>
          </div>
          <template v-if="freshCodes.length">
            <p class="help">{{ t('twoFactor.recoveryHint') }}</p>
            <ul class="codes"><li v-for="c in freshCodes" :key="c"><code>{{ c }}</code></li></ul>
          </template>
        </div>
        <div v-else class="row">
          <button class="btn ghost" type="button" @click="action = 'replace'; notice = ''">{{ t('twoFactor.replace') }}</button>
          <button class="btn ghost" type="button" @click="action = 'codes'; notice = ''; freshCodes = []">{{ t('twoFactor.newCodes') }}</button>
          <button class="btn ghost" type="button" :disabled="status.required" :title="status.required ? t('twoFactor.requiredNoDisable') : ''" @click="action = 'disable'; notice = ''">{{ t('twoFactor.disable') }}</button>
        </div>
        <p v-if="status.required && !action" class="help">{{ t('twoFactor.requiredNoDisable') }}</p>
      </template>
    </section>

    <section v-if="overview" class="block">
      <h3 class="block-title">{{ t('twoFactor.admins') }}</h3>
      <p class="help">{{ t('twoFactor.adminsHint') }}</p>
      <div class="table-wrap">
        <table class="table">
          <thead><tr><th>{{ t('twoFactor.person') }}</th><th>{{ t('twoFactor.state') }}</th><th /></tr></thead>
          <tbody>
            <tr v-for="a in overview.admins" :key="a.userId">
              <td>{{ a.fullName }}</td>
              <td><span :class="['badge', a.enrolled ? 'teal' : 'sun']">{{ a.enrolled ? t('twoFactor.on') : t('twoFactor.off') }}</span></td>
              <td class="num">
                <button v-if="a.enrolled && a.userId !== me?.user.id && hasScope('people.password')" class="btn ghost small" type="button" @click="reset(a.userId, a.fullName)">{{ t('twoFactor.reset') }}</button>
              </td>
            </tr>
          </tbody>
        </table>
      </div>
      <p class="help">{{ t('twoFactor.lostEverything') }}</p>
    </section>
  </div>
</template>

<style scoped>
.tf { display: grid; gap: var(--space-3); }
.row { display: flex; gap: var(--space-2); flex-wrap: wrap; align-items: center; }
.row.off { opacity: 0.5; }
.block { display: grid; gap: var(--space-2); border-top: 1px solid var(--color-bg-line-soft); padding-top: var(--space-3); }
.block-title { margin: 0; font-size: var(--font-size-body); font-weight: 800; }
.proof { display: grid; gap: var(--space-2); max-width: 360px; }
.codes { list-style: none; margin: 0; padding: 0; display: grid; grid-template-columns: repeat(auto-fill, minmax(140px, 1fr)); gap: var(--space-2); }
.codes code { display: block; background: var(--color-bg-soft); border-radius: var(--radius-s); padding: var(--space-1) var(--space-2); font-weight: 700; }
</style>
