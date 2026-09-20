<script setup lang="ts">
definePageMeta({ layout: false })
// Нетипизированный вызов: типизированные роуты Nitro при сотнях эндпоинтов дают TS2589
const rawFetch = $fetch as unknown as <T>(url: string, opts?: { method?: string, body?: unknown, headers?: Record<string, string> }) => Promise<T>
const { t } = useI18n()
const { fetchMe } = useAuth()

type Step = 'phone' | 'code' | 'tenant' | 'password'
const step = ref<Step>('phone')
const devCode = ref('')
const phone = ref('')
const code = ref('')
const channel = ref<'telegram' | 'sms' | 'email'>('sms')
const maskedEmail = ref('')
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
const codeHelp = ref(false)
const codeInput = ref<HTMLInputElement | null>(null)
const supportContact = String(useRuntimeConfig().public.supportContact || '')
// Гостевая страница (docs/21 Г-21.3, docs/25 §4): три блока тенанта до входа; тенант — по поддомену Host, в dev — ?tenant=
interface Guest { name: string, slug: string, passwordLogin?: boolean, blocks: { welcome: unknown[], supportContact: { name?: string, phone?: string, email?: string, telegram?: string }, policyUrl: string | null } }
const guest = ref<Guest | null>(null)
onMounted(async () => {
  try { guest.value = (await rawFetch<{ data: Guest }>(`/api/v1/public/guest-page?slug=${encodeURIComponent(tenantSlug.value)}`)).data }
  catch { guest.value = null }
})
const maskedPhone = computed(() => {
  const d = phone.value.replace(/\D/g, '')
  return `+380 ${d.slice(0, 2)} ${d.slice(2, 5)} ${d.slice(5, 7)} ${d.slice(7, 9)}`.trim()
})
function focusCode() { codeInput.value?.focus() }
watch(step, (v) => { if (v === 'code') nextTick(focusCode) })
watch(code, (v) => { if (v.length === 6 && !busy.value) verifyCode() })
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

async function requestCode(explicitChannel?: 'email') {
  error.value = ''
  busy.value = true
  try {
    const data = await rawFetch<{ data: { channel: 'telegram' | 'sms' | 'email', maskedEmail?: string, devCode?: string } }>(
      '/api/v1/auth/otp/request',
      { method: 'POST', body: { phone: normalizedPhone(), ...(explicitChannel ? { channel: explicitChannel } : {}) } },
    )
    channel.value = data.data.channel
    maskedEmail.value = data.data.maskedEmail ?? ''
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
    code.value = ''
    nextTick(focusCode)
  }
  finally {
    busy.value = false
  }
}

// Вход по e-mail + паролю (docs/01 §1.5, docs/04 §4.2) — резервный способ, если включён политикой тенанта
const email = ref('')
const password = ref('')
async function loginPassword() {
  error.value = ''
  busy.value = true
  try {
    const res = await rawFetch<{ data: { requiresTenantSelect: boolean, mustChangePassword?: boolean, selectToken?: string, tenants?: { tenantId: string, name: string, slug: string }[] } }>('/api/v1/auth/password/login', { method: 'POST', body: { email: email.value.trim(), password: password.value } })
    if (res.data.requiresTenantSelect) {
      selectToken.value = res.data.selectToken!
      tenantOptions.value = res.data.tenants!
      step.value = 'tenant'
      return
    }
    await fetchMe()
    await navigateTo(res.data.mustChangePassword ? '/learn/profile?password=1' : '/')
  }
  catch (err) { error.value = apiErrorOf(err).message }
  finally { busy.value = false }
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
            @keyup.enter="requestCode()"
          >
        </div>
        <button class="primary" :disabled="busy || phone.replace(/\D/g, '').length !== 9" @click="requestCode()">
          {{ t('login.getCode') }}
        </button>
        <button v-if="googleAvailable" class="ghost" data-testid="login-google" @click="loginGoogle">{{ t('login.google') }}</button>
        <button class="linkish" type="button" :disabled="busy || phone.replace(/\D/g, '').length !== 9" data-testid="login-email-otp-link" @click="requestCode('email')">{{ t('login.byEmailOtp') }}</button>
        <button v-if="guest?.passwordLogin" class="linkish" type="button" data-testid="login-password-link" @click="step = 'password'; error = ''">{{ t('login.byPassword') }}</button>
      </template>

      <template v-else-if="step === 'password'">
        <h2 class="title">{{ t('login.byPassword') }}</h2>
        <p class="hint">{{ t('login.byPasswordHint') }}</p>
        <label class="label" for="email">{{ t('login.email') }}</label>
        <input id="email" v-model="email" type="email" autocomplete="username" inputmode="email" @keyup.enter="loginPassword">
        <label class="label" for="password">{{ t('login.password') }}</label>
        <input id="password" v-model="password" type="password" autocomplete="current-password" @keyup.enter="loginPassword">
        <button class="primary" :disabled="busy || !email.includes('@') || !password" @click="loginPassword">{{ t('login.signIn') }}</button>
        <button class="linkish" type="button" @click="step = 'phone'; error = ''">{{ t('login.byCode') }}</button>
      </template>

      <template v-else-if="step === 'code'">
        <h2 class="title">{{ t('login.enterCode') }}</h2>
        <p class="hint">
          {{ channel === 'telegram' ? t('login.sentTelegramTo') : channel === 'email' ? t('login.sentEmailTo') : t('login.sentSmsTo') }}
          <b class="phone-b">{{ channel === 'email' ? maskedEmail : maskedPhone }}</b>
        </p>
        <p v-if="devCode" class="hint demo-code">{{ t('login.demoCode') }}: <b>{{ devCode }}</b></p>
        <!-- Шесть ячеек мокапа Login: настоящий ввод — один скрытый input, ячейки только показывают цифры -->
        <div class="cells" @click="focusCode">
          <span v-for="i in 6" :key="i" :class="['cell', { filled: code.length >= i, active: code.length === i - 1 }]">{{ code[i - 1] ?? '' }}</span>
          <input
            ref="codeInput"
            v-model="code"
            class="code-hidden"
            type="text"
            inputmode="numeric"
            pattern="[0-9]*"
            maxlength="6"
            autocomplete="one-time-code"
            :aria-label="t('login.enterCode')"
            @input="code = code.replace(/\D/g, '').slice(0, 6)"
            @keyup.enter="verifyCode"
          >
        </div>
        <button class="primary" :disabled="busy || code.length !== 6" @click="verifyCode">
          {{ t('login.signIn') }}
        </button>
        <p v-if="resendIn > 0" class="hint muted">{{ t('login.resendInShort') }} <b>{{ resendIn }} с</b></p>
        <button v-else class="ghost" :disabled="busy" @click="requestCode(channel === 'email' ? 'email' : undefined)">{{ t('login.resend') }}</button>
        <button class="linkish" type="button" @click="codeHelp = !codeHelp">{{ t('login.noCode') }}</button>
        <div v-if="codeHelp" class="help-box">
          <p>{{ channel === 'telegram' ? t('login.noCodeTelegram') : channel === 'email' ? t('login.noCodeEmail') : t('login.noCodeSms') }}</p>
          <button class="ghost" @click="step = 'phone'; codeHelp = false">{{ t('login.changePhone') }}</button>
        </div>
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
      <section v-if="guest" class="guest" data-testid="guest-blocks">
        <div v-if="guest.blocks.welcome.length" class="guest-welcome"><LessonBlocks :blocks="guest.blocks.welcome as never" :blocks-state="{}" readonly /></div>
        <p v-if="guest.blocks.supportContact.name || guest.blocks.supportContact.phone || guest.blocks.supportContact.email || guest.blocks.supportContact.telegram" class="support">
          {{ t('login.guestSupport') }}<template v-if="guest.blocks.supportContact.name"> {{ guest.blocks.supportContact.name }}</template><template v-if="guest.blocks.supportContact.phone"> · <a :href="`tel:${guest.blocks.supportContact.phone}`">{{ guest.blocks.supportContact.phone }}</a></template><template v-if="guest.blocks.supportContact.email"> · <a :href="`mailto:${guest.blocks.supportContact.email}`">{{ guest.blocks.supportContact.email }}</a></template><template v-if="guest.blocks.supportContact.telegram"> · {{ guest.blocks.supportContact.telegram }}</template>
        </p>
        <p v-if="guest.blocks.policyUrl" class="support"><a :href="guest.blocks.policyUrl" target="_blank" rel="noopener">{{ t('login.policy') }}</a></p>
      </section>
      <p class="support">
        {{ t('login.support') }}<template v-if="supportContact"> {{ t('login.supportOr') }} <a :href="`mailto:${supportContact}`">{{ supportContact }}</a></template>
      </p>
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
.title { margin: 0; font-size: 28px; font-weight: 900; letter-spacing: -0.02em; }
.phone-b { display: block; color: var(--color-ink); }
.cells { position: relative; display: flex; gap: var(--space-2); justify-content: space-between; cursor: text; }
.cell { flex: 1; aspect-ratio: 46 / 56; max-width: 52px; display: grid; place-items: center; border: 2px solid var(--color-bg-line); border-radius: 14px; background: var(--color-bg); font-size: 24px; font-weight: 900; }
.cell.filled { border-color: var(--color-ink); }
.cell.active { border-color: var(--color-ink); box-shadow: inset 0 0 0 1px var(--color-ink); }
.code-hidden { position: absolute; inset: 0; opacity: 0; width: 100%; height: 100%; font-size: 24px; }
.linkish { background: none; color: var(--color-teal-ink); padding: 0; text-align: left; font-weight: 800; }
.help-box { display: grid; gap: var(--space-2); background: var(--color-bg); border-radius: var(--radius-m); padding: var(--space-3) var(--space-4); font-size: var(--font-size-body-s); color: var(--color-ink-muted); }
.help-box p { margin: 0; }
.guest { margin-top: var(--space-3); display: grid; gap: var(--space-1); }
.guest-welcome { font-size: var(--font-size-body-s); color: var(--color-ink-muted); }
.support { margin: var(--space-2) 0 0; padding-top: var(--space-3); border-top: 1px solid var(--color-bg-line-soft); font-size: var(--font-size-body-s); color: var(--color-ink-muted); }
.support a { color: var(--color-teal-ink); }

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
