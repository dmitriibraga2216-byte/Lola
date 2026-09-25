<script setup lang="ts">
/**
 * Ссылка-приглашение (docs/01 §1.5 «для першого входу», docs/16 §8 `user_invited`):
 * посилання формує `createInvitation()` як `/invite?token=…`, приймає `POST /auth/invite/accept` —
 * саме володіння токеном і є входом, без коду/пароля/Google (це окремі, повноцінні способи входу
 * на `/login`, тут — жоден з них). Публічна сторінка (`app/middleware/auth.global.ts`,
 * `app/app.vue` — обидва місця, де тримають виняток для публічних шляхів, PR-16 тут спіткнувся):
 * без сесії показує назву простору й кнопку «Увійти», з протухлим/використаним токеном —
 * зрозумілий текст замість 404.
 */
definePageMeta({ layout: false })
// Нетипизированный вызов: типизированные роуты Nitro при сотнях эндпоинтов дают TS2589 (см. login.vue)
const rawFetch = $fetch as unknown as <T>(url: string, opts?: { method?: string, body?: unknown, headers?: Record<string, string> }) => Promise<T>
const { t } = useI18n()
const { fetchMe } = useAuth()
const route = useRoute()

type Screen = 'loading' | 'ready' | 'invalid' | 'twoFactor'
const screen = ref<Screen>('loading')
const tenantName = ref('')
const error = ref('')
const busy = ref(false)
const token = computed(() => String(route.query.token || ''))

const twoFactor = ref<'verify' | 'enroll' | null>(null)
const tfCode = ref('')
const tfRecovery = ref('')
const useRecovery = ref(false)

async function loadPreview() {
  if (!token.value) {
    screen.value = 'invalid'
    return
  }
  try {
    const res = await rawFetch<{ data: { tenantName: string } }>(`/api/v1/public/invite/${encodeURIComponent(token.value)}`)
    tenantName.value = res.data.tenantName
    screen.value = 'ready'
  }
  catch {
    screen.value = 'invalid'
  }
}
onMounted(loadPreview)

async function acceptInvite() {
  error.value = ''
  busy.value = true
  try {
    const res = await rawFetch<{ data: { twoFactor?: 'verify' | 'enroll' | null } }>('/api/v1/auth/invite/accept', {
      method: 'POST',
      body: { token: token.value },
    })
    if (res.data.twoFactor) {
      twoFactor.value = res.data.twoFactor
      screen.value = 'twoFactor'
      return
    }
    await fetchMe()
    await navigateTo('/')
  }
  catch (err) {
    const e = apiErrorOf(err)
    if (e.code === 'invite_invalid') screen.value = 'invalid'
    else error.value = e.message
  }
  finally {
    busy.value = false
  }
}

async function verifySecondFactor() {
  error.value = ''
  busy.value = true
  try {
    await rawFetch('/api/v1/auth/two-factor/verify', { method: 'POST', body: useRecovery.value ? { recoveryCode: tfRecovery.value.trim() } : { code: tfCode.value.trim() } })
    await fetchMe()
    await navigateTo('/')
  }
  catch (err) {
    const e = apiErrorOf(err)
    const left = (e.details as { attemptsLeft?: number } | undefined)?.attemptsLeft
    error.value = left !== undefined ? t('twoFactor.invalidLeft', { n: left }) : e.message
    tfCode.value = ''
    // Промежуточная сессия закрыта (перебор или истекла) — приглашение уже принято, начинать вход заново на /login
    if (e.code === 'rate_limited' || e.code === 'two_factor.not_pending' || e.code === 'auth_required') await navigateTo('/login')
  }
  finally { busy.value = false }
}

async function afterEnroll() {
  await fetchMe()
  await navigateTo('/')
}

watch(tfCode, (v) => { if (v.length === 6 && !busy.value && screen.value === 'twoFactor' && !useRecovery.value) verifySecondFactor() })
</script>

<template>
  <main class="invite">
    <div class="card">
      <h1 class="brand">{{ t('app.name') }}</h1>

      <template v-if="screen === 'loading'">
        <p class="hint">{{ t('invite.loading') }}</p>
      </template>

      <template v-else-if="screen === 'invalid'">
        <p class="error" role="alert" data-testid="invite-invalid">{{ t('invite.invalid') }}</p>
      </template>

      <template v-else-if="screen === 'ready'">
        <h2 class="title">{{ t('invite.toSpace', { name: tenantName }) }}</h2>
        <button class="primary" :disabled="busy" data-testid="invite-sign-in" @click="acceptInvite">
          {{ t('login.signIn') }}
        </button>
      </template>

      <template v-else-if="screen === 'twoFactor'">
        <h2 class="title">{{ t('twoFactor.loginTitle') }}</h2>
        <template v-if="twoFactor === 'enroll'">
          <p class="hint">{{ t('twoFactor.loginEnrollHint') }}</p>
          <TwoFactorEnroll mode="enroll" @done="afterEnroll" />
        </template>
        <template v-else>
          <template v-if="!useRecovery">
            <p class="hint">{{ t('twoFactor.loginVerifyHint') }}</p>
            <input v-model="tfCode" class="code-input" inputmode="numeric" pattern="[0-9]*" maxlength="6" autocomplete="one-time-code" :aria-label="t('twoFactor.loginVerifyHint')" data-testid="two-factor-code" @input="tfCode = tfCode.replace(/\D/g, '').slice(0, 6)" @keyup.enter="verifySecondFactor">
            <button class="primary" :disabled="busy || tfCode.length !== 6" @click="verifySecondFactor">{{ t('login.signIn') }}</button>
            <button class="linkish" type="button" @click="useRecovery = true; error = ''">{{ t('twoFactor.useRecovery') }}</button>
          </template>
          <template v-else>
            <p class="hint">{{ t('twoFactor.recoveryLoginHint') }}</p>
            <input v-model="tfRecovery" class="code-input" autocomplete="off" maxlength="20" :aria-label="t('twoFactor.recoveryLoginHint')" @keyup.enter="verifySecondFactor">
            <button class="primary" :disabled="busy || tfRecovery.trim().length < 10" @click="verifySecondFactor">{{ t('login.signIn') }}</button>
            <button class="linkish" type="button" @click="useRecovery = false; error = ''">{{ t('twoFactor.useApp') }}</button>
          </template>
          <p class="hint muted">{{ t('twoFactor.lostPhone') }}</p>
        </template>
      </template>

      <p v-if="error" class="error" role="alert">{{ error }}</p>
    </div>
  </main>
</template>

<style scoped>
.invite {
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
  box-sizing: border-box;
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

.title { margin: 0; font-size: 28px; font-weight: 900; letter-spacing: -0.02em; color: var(--color-ink); }

input {
  border: 1px solid var(--color-bg-line);
  outline: none;
  background: var(--color-bg);
  font: inherit;
  color: var(--color-ink);
  width: 100%;
  box-sizing: border-box;
}

.code-input {
  border-radius: var(--radius-s);
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

.linkish { background: none; color: var(--color-teal-ink); padding: 0; text-align: left; font-weight: 800; }

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
