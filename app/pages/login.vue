<script setup lang="ts">
// Нетипизированный вызов: типизированные роуты Nitro при сотнях эндпоинтов дают TS2589
const rawFetch = $fetch as unknown as <T>(url: string, opts?: { method?: string, body?: unknown, headers?: Record<string, string> }) => Promise<T>
const { t } = useI18n()
const { fetchMe } = useAuth()

type Step = 'phone' | 'code' | 'tenant'
const step = ref<Step>('phone')
const devCode = ref('')
const phone = ref('')
const code = ref('')
const channel = ref<'telegram' | 'sms'>('sms')
const error = ref('')
const busy = ref(false)
// Вход через Google (docs/09 §9.1): ссылку даёт сервер; тенант — из ?tenant= или единственный на этом хосте
const route = useRoute()
const googleAvailable = ref(false)
const tenantSlug = computed(() => String(route.query.tenant || useRuntimeConfig().public.defaultTenant || 'kappi'))
onMounted(async () => {
  const err = route.query.error as string | undefined
  if (err) error.value = err === 'google_no_user' ? t('login.errors.google_no_user') : t('login.errors.oauth')
  try { await rawFetch<unknown>(`/api/v1/auth/google/url?tenant=${encodeURIComponent(tenantSlug.value)}`); googleAvailable.value = true } catch { googleAvailable.value = false }
})
async function loginGoogle() {
  try { const r = await rawFetch<{ data: { url: string } }>(`/api/v1/auth/google/url?tenant=${encodeURIComponent(tenantSlug.value)}`); window.location.href = r.data.url }
  catch (err) { error.value = apiErrorOf(err).message }
}
const resendIn = ref(0)
const selectToken = ref('')
const tenantOptions = ref<{ tenantId: string, name: string, slug: string }[]>([])

let timer: ReturnType<typeof setInterval> | undefined
function startResendTimer() {
  resendIn.value = 60
  clearInterval(timer)
  timer = setInterval(() => {
    resendIn.value -= 1
    if (resendIn.value <= 0) clearInterval(timer)
  }, 1000)
}
onUnmounted(() => clearInterval(timer))

function normalizedPhone(): string {
  return `+380${phone.value.replace(/\D/g, '')}`
}

async function requestCode() {
  error.value = ''
  busy.value = true
  try {
    const data = await rawFetch<{ data: { channel: 'telegram' | 'sms', devCode?: string } }>(
      '/api/v1/auth/otp/request',
      { method: 'POST', body: { phone: normalizedPhone() } },
    )
    channel.value = data.data.channel
    devCode.value = data.data.devCode ?? '' // только демо-стенд/dev (OTP_DEBUG=1), в проде поля нет
    step.value = 'code'
    code.value = ''
    startResendTimer()
  }
  catch (err) {
    error.value = apiErrorOf(err).message
  }
  finally {
    busy.value = false
  }
}

async function verifyCode() {
  error.value = ''
  busy.value = true
  try {
    const res = await rawFetch<{ data: {
      requiresTenantSelect: boolean
      selectToken?: string
      tenants?: { tenantId: string, name: string, slug: string }[]
    } }>('/api/v1/auth/otp/verify', {
      method: 'POST',
      body: { phone: normalizedPhone(), code: code.value },
    })
    if (res.data.requiresTenantSelect) {
      selectToken.value = res.data.selectToken!
      tenantOptions.value = res.data.tenants!
      step.value = 'tenant'
      return
    }
    await fetchMe()
    await navigateTo('/')
  }
  catch (err) {
    const e = apiErrorOf(err)
    const left = (e.details as { attemptsLeft?: number } | undefined)?.attemptsLeft
    error.value = left !== undefined
      ? t('login.codeInvalidLeft', { n: left })
      : e.message
  }
  finally {
    busy.value = false
  }
}

async function selectTenant(tenantId: string) {
  error.value = ''
  busy.value = true
  try {
    await rawFetch('/api/v1/auth/tenant/select', {
      method: 'POST',
      body: { selectToken: selectToken.value, tenantId },
    })
    await fetchMe()
    await navigateTo('/')
  }
  catch (err) {
    error.value = apiErrorOf(err).message
  }
  finally {
    busy.value = false
  }
}
</script>

<template>
  <main class="login">
    <div class="card">
      <h1 class="brand">{{ t('app.name') }}</h1>

      <template v-if="step === 'phone'">
        <label class="label" for="phone">{{ t('login.phoneLabel') }}</label>
        <div class="phone-row">
          <span class="prefix">+380</span>
          <input
            id="phone"
            v-model="phone"
            type="tel"
            inputmode="numeric"
            maxlength="9"
            placeholder="__ ___ __ __"
            autocomplete="tel-national"
            @keyup.enter="requestCode"
          >
        </div>
        <button class="primary" :disabled="busy || phone.replace(/\D/g, '').length !== 9" @click="requestCode">
          {{ t('login.getCode') }}
        </button>
        <button v-if="googleAvailable" class="ghost" data-testid="login-google" @click="loginGoogle">{{ t('login.google') }}</button>
      </template>

      <template v-else-if="step === 'code'">
        <p class="hint">
          {{ channel === 'telegram' ? t('login.sentTelegram') : t('login.sentSms') }}
        </p>
        <p v-if="devCode" class="hint demo-code">{{ t('login.demoCode') }}: <b>{{ devCode }}</b></p>
        <input
          v-model="code"
          class="code-input"
          type="text"
          inputmode="numeric"
          maxlength="6"
          autocomplete="one-time-code"
          placeholder="······"
          @keyup.enter="verifyCode"
        >
        <button class="primary" :disabled="busy || code.length !== 6" @click="verifyCode">
          {{ t('login.signIn') }}
        </button>
        <button v-if="resendIn <= 0" class="ghost" :disabled="busy" @click="requestCode">
          {{ t('login.resend') }}
        </button>
        <p v-else class="hint muted">{{ t('login.resendIn', { s: resendIn }) }}</p>
      </template>

      <template v-else>
        <p class="hint">{{ t('login.chooseSpace') }}</p>
        <button
          v-for="option in tenantOptions"
          :key="option.tenantId"
          class="tenant"
          :disabled="busy"
          @click="selectTenant(option.tenantId)"
        >
          {{ option.name }}
        </button>
      </template>

      <p v-if="error" class="error">{{ error }}</p>
    </div>
  </main>
</template>

<style scoped>
.login {
  min-height: 100dvh;
  display: grid;
  place-items: center;
  padding: var(--space-4);
  background: var(--color-bg);
  font-family: var(--font-family);
}

.card {
  width: min(400px, 100%);
  background: var(--color-bg-soft);
  border: 1px solid var(--color-bg-line);
  border-radius: var(--radius-2xl);
  padding: var(--space-6);
  display: grid;
  gap: var(--space-4);
}

.brand {
  margin: 0;
  font-weight: 900;
  font-size: var(--font-size-display);
  color: var(--color-ink);
  text-align: center;
}

.label {
  font-size: var(--font-size-body-s);
  color: var(--color-ink-muted);
}

.phone-row {
  display: flex;
  align-items: center;
  gap: var(--space-2);
  border: 1px solid var(--color-bg-line);
  border-radius: var(--radius-s);
  background: var(--color-bg);
  padding: var(--space-3) var(--space-4);
}

.prefix {
  font-weight: 700;
  color: var(--color-ink);
}

input {
  border: none;
  outline: none;
  background: transparent;
  font: inherit;
  color: var(--color-ink);
  width: 100%;
}

.code-input {
  border: 1px solid var(--color-bg-line);
  border-radius: var(--radius-s);
  background: var(--color-bg);
  padding: var(--space-3) var(--space-4);
  text-align: center;
  font-size: var(--font-size-title-l);
  letter-spacing: 0.5em;
}

button {
  font: inherit;
  border: none;
  cursor: pointer;
  border-radius: var(--radius-pill);
  padding: var(--space-3) var(--space-5);
  font-weight: 800;
}

button:disabled {
  opacity: 0.5;
  cursor: default;
}

.primary {
  background: var(--color-sun);
  color: var(--color-ink);
}

.ghost {
  background: transparent;
  color: var(--color-ink-muted);
}

.tenant {
  background: var(--color-bg);
  border: 1px solid var(--color-bg-line);
  border-radius: var(--radius-m);
  color: var(--color-ink);
  text-align: left;
  padding: var(--space-4);
}

.demo-code { background: var(--color-sun); border-radius: var(--radius-m); padding: var(--space-2) var(--space-3); color: var(--color-ink); }

.hint {
  margin: 0;
  color: var(--color-ink);
}

.muted {
  color: var(--color-ink-faint);
  font-size: var(--font-size-body-s);
  text-align: center;
}

.error {
  margin: 0;
  color: var(--color-coral-ink);
  font-size: var(--font-size-body-s);
}
</style>
