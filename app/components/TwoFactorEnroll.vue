<script setup lang="ts">
/**
 * Подключение приложения-аутентификатора (docs/24 §3.4, PR-39): ключ → QR и ключ текстом →
 * первый код из приложения → десять резервных кодов, **показанных один раз**. Один компонент на
 * два места: экран входа (промежуточная сессия `enroll`) и блок «Мій вхід» в настройках.
 * `replace` — замена устройства: сервер требует текущий код, старый фактор действует до
 * подтверждения нового.
 */
import QRCode from 'qrcode'

const props = defineProps<{ mode: 'enroll' | 'replace' }>()
const emit = defineEmits<{ done: [signedIn: boolean], cancel: [] }>()
const { t } = useI18n()
const { api } = useApi()

type Step = 'start' | 'scan' | 'codes'
const step = ref<Step>('start')
const current = ref('')
const code = ref('')
const secret = ref('')
const qr = ref('')
const codes = ref<string[]>([])
const saved = ref(false)
const signedIn = ref(false)
const busy = ref(false)
const error = ref('')
const copied = ref(false)

/** Ключ группами по четыре — так его проще переписать руками в приложение. */
const secretGroups = computed(() => secret.value.match(/.{1,4}/g)?.join(' ') ?? '')

function failText(err: unknown): string {
  const e = apiErrorOf(err)
  const left = (e.details as { attemptsLeft?: number } | undefined)?.attemptsLeft
  return left !== undefined ? t('twoFactor.invalidLeft', { n: left }) : e.message
}

async function start() {
  error.value = ''
  busy.value = true
  try {
    const r = await api<{ secret: string, otpauthUrl: string }>('/auth/two-factor/setup', { method: 'POST', body: props.mode === 'replace' ? { code: current.value.trim() } : {} })
    secret.value = r.secret
    qr.value = await QRCode.toDataURL(r.otpauthUrl, { width: 220, margin: 1 })
    step.value = 'scan'
    code.value = ''
  }
  catch (err) { error.value = failText(err) }
  finally { busy.value = false }
}

async function confirm() {
  error.value = ''
  busy.value = true
  try {
    const r = await api<{ recoveryCodes: string[], signedIn: boolean }>('/auth/two-factor/confirm', { method: 'POST', body: { code: code.value.trim() } })
    codes.value = r.recoveryCodes
    signedIn.value = r.signedIn
    // Ключ больше не нужен на экране — только коды
    secret.value = ''
    qr.value = ''
    step.value = 'codes'
  }
  catch (err) { error.value = failText(err); code.value = '' }
  finally { busy.value = false }
}

async function copy() {
  try { await navigator.clipboard.writeText(codes.value.join('\n')); copied.value = true }
  catch { copied.value = false }
}

onMounted(() => { if (props.mode === 'enroll') start() })
</script>

<template>
  <div class="enroll">
    <template v-if="step === 'start'">
      <template v-if="mode === 'replace'">
        <label class="label" for="tf-current">{{ t('twoFactor.currentCode') }}</label>
        <input id="tf-current" v-model="current" class="field code" inputmode="numeric" autocomplete="one-time-code" maxlength="6" @keyup.enter="start">
        <p class="help">{{ t('twoFactor.replaceHint') }}</p>
        <div class="row">
          <button class="btn primary" type="button" :disabled="busy || current.trim().length !== 6" @click="start">{{ t('twoFactor.getKey') }}</button>
          <button class="btn ghost" type="button" @click="emit('cancel')">{{ t('common.cancel') }}</button>
        </div>
      </template>
      <p v-else class="help">{{ t('twoFactor.preparing') }}</p>
    </template>

    <template v-else-if="step === 'scan'">
      <ol class="steps">
        <li>{{ t('twoFactor.stepApp') }}</li>
        <li>{{ t('twoFactor.stepScan') }}</li>
      </ol>
      <img v-if="qr" :src="qr" :alt="t('twoFactor.qrAlt')" class="qr" width="220" height="220">
      <p class="help">{{ t('twoFactor.manualKey') }}</p>
      <code class="secret" data-testid="two-factor-secret">{{ secretGroups }}</code>
      <label class="label" for="tf-code">{{ t('twoFactor.stepCode') }}</label>
      <input id="tf-code" v-model="code" class="field code" inputmode="numeric" autocomplete="one-time-code" maxlength="6" data-testid="two-factor-confirm-code" @keyup.enter="confirm">
      <div class="row">
        <button class="btn primary" type="button" :disabled="busy || code.trim().length !== 6" data-testid="two-factor-confirm" @click="confirm">{{ t('twoFactor.confirm') }}</button>
        <button v-if="mode === 'replace'" class="btn ghost" type="button" @click="emit('cancel')">{{ t('common.cancel') }}</button>
      </div>
    </template>

    <template v-else>
      <p class="note teal" role="status">{{ t('twoFactor.enabledNow') }}</p>
      <p class="label">{{ t('twoFactor.recoveryTitle') }}</p>
      <p class="help">{{ t('twoFactor.recoveryHint') }}</p>
      <ul class="codes" data-testid="two-factor-recovery-codes">
        <li v-for="c in codes" :key="c"><code>{{ c }}</code></li>
      </ul>
      <div class="row">
        <button class="btn ghost small" type="button" @click="copy">{{ copied ? t('twoFactor.copied') : t('twoFactor.copy') }}</button>
      </div>
      <label class="toggle row"><input v-model="saved" type="checkbox" data-testid="two-factor-saved"><span>{{ t('twoFactor.savedCodes') }}</span></label>
      <button class="btn primary" type="button" :disabled="!saved" data-testid="two-factor-done" @click="emit('done', signedIn)">{{ t('twoFactor.done') }}</button>
    </template>

    <p v-if="error" class="error-text" role="alert">{{ error }}</p>
  </div>
</template>

<style scoped>
.enroll { display: grid; gap: var(--space-2); }
.row { display: flex; gap: var(--space-2); flex-wrap: wrap; align-items: center; }
.steps { margin: 0; padding-left: var(--space-5); display: grid; gap: var(--space-1); }
.qr { border-radius: var(--radius-s); background: var(--color-bg-soft); justify-self: start; }
.secret { font-size: var(--font-size-body); letter-spacing: 0.08em; word-break: break-all; background: var(--color-bg-soft); border-radius: var(--radius-s); padding: var(--space-2) var(--space-3); }
.code { max-width: 160px; letter-spacing: 0.2em; font-weight: 800; }
.codes { list-style: none; margin: 0; padding: 0; display: grid; grid-template-columns: repeat(auto-fill, minmax(140px, 1fr)); gap: var(--space-2); }
.codes code { display: block; background: var(--color-bg-soft); border-radius: var(--radius-s); padding: var(--space-1) var(--space-2); font-weight: 700; }
</style>
