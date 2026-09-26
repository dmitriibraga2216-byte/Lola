<script setup lang="ts">
/**
 * Второй фактор оператора (docs/25 §7 п. 8): не настроен — подключение приложения (тот же компонент,
 * что у пользователей тенанта, ручки `/platform/two-factor/*`); настроен — код или резервный код.
 * Пока шаг не пройден, консоль отвечает 401 на всё, кроме этого экрана и выхода.
 */
definePageMeta({ layout: false })
const { t } = useI18n()
const { me, fetchMe, logout } = useOps()
const code = ref('')
const recovery = ref('')
const useRecovery = ref(false)
const error = ref('')
const busy = ref(false)

onMounted(async () => {
  const who = await fetchMe()
  if (!who) return navigateTo('/ops/login')
  if (!who.twoFactor) return navigateTo('/ops/companies')
})

async function verify() {
  if (busy.value) return
  error.value = ''
  busy.value = true
  try {
    await opsFetch('/api/v1/platform/two-factor/verify', { method: 'POST', body: useRecovery.value ? { recoveryCode: recovery.value.trim() } : { code: code.value.trim() } })
    await fetchMe()
    await navigateTo('/ops/companies')
  }
  catch (err) { error.value = apiErrorOf(err).message; code.value = '' }
  finally { busy.value = false }
}

async function enrolled() {
  await fetchMe()
  await navigateTo('/ops/companies')
}
</script>

<template>
  <main class="ops-auth">
    <div class="card box">
      <h1>{{ t('opsConsole.twoFactor.title') }}</h1>
      <template v-if="me?.twoFactor === 'enroll'">
        <p class="muted">{{ t('opsConsole.twoFactor.enrollHint') }}</p>
        <TwoFactorEnroll mode="enroll" endpoint="/platform/two-factor" @done="enrolled" />
      </template>
      <form v-else-if="me?.twoFactor === 'verify'" class="grid" @submit.prevent="verify">
        <template v-if="!useRecovery">
          <label class="label" for="ops-code">{{ t('opsConsole.twoFactor.code') }}</label>
          <input id="ops-code" v-model="code" class="field" inputmode="numeric" autocomplete="one-time-code" maxlength="6" required>
        </template>
        <template v-else>
          <label class="label" for="ops-recovery">{{ t('opsConsole.twoFactor.recovery') }}</label>
          <input id="ops-recovery" v-model="recovery" class="field" autocomplete="off" required>
        </template>
        <p v-if="error" class="error-text" role="alert">{{ error }}</p>
        <div class="chips">
          <button type="submit" class="btn primary" :disabled="busy">{{ t('opsConsole.twoFactor.confirm') }}</button>
          <button type="button" class="btn ghost small" @click="useRecovery = !useRecovery; error = ''">{{ useRecovery ? t('twoFactor.useApp') : t('twoFactor.useRecovery') }}</button>
        </div>
        <p class="muted small">{{ t('opsConsole.twoFactor.lost') }}</p>
      </form>
      <button type="button" class="btn ghost small" @click="logout">{{ t('home.logout') }}</button>
    </div>
  </main>
</template>

<style scoped>
.ops-auth { min-height: 100vh; display: grid; place-items: start center; padding: var(--space-7) var(--space-4); background: var(--color-bg); font-family: var(--font-family); }
.box { width: 100%; max-width: 440px; display: grid; gap: var(--space-3); box-sizing: border-box; }
.grid { display: grid; gap: var(--space-2); }
h1 { margin: 0; font-size: var(--font-size-title-l); font-weight: 900; }
.small { font-size: var(--font-size-body-s); }
.box > .btn { justify-self: start; }
</style>
