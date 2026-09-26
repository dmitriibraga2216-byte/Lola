<script setup lang="ts">
/**
 * Вход в консоль оператора (docs/25 §7 п. 8): e-mail и пароль — первый шаг, дальше всегда второй
 * фактор (код или подключение приложения).
 */
definePageMeta({ layout: false })
const { t } = useI18n()
const { fetchMe } = useOps()
const form = reactive({ email: '', password: '' })
const error = ref('')
const busy = ref(false)

onMounted(async () => {
  const who = await fetchMe()
  if (who) await navigateTo(who.twoFactor ? '/ops/two-factor' : '/ops/companies')
})

async function submit() {
  if (busy.value) return
  error.value = ''
  busy.value = true
  try {
    await $fetch('/api/v1/platform/login', { method: 'POST', body: { email: form.email.trim(), password: form.password } })
    await fetchMe()
    await navigateTo('/ops/two-factor')
  }
  catch (err) { error.value = apiErrorOf(err).message }
  finally { busy.value = false }
}
</script>

<template>
  <main class="ops-auth">
    <form class="card box" @submit.prevent="submit">
      <h1>{{ t('opsConsole.login.title') }}</h1>
      <p class="muted">{{ t('opsConsole.login.hint') }}</p>
      <label class="label" for="ops-email">{{ t('opsConsole.login.email') }}</label>
      <input id="ops-email" v-model="form.email" class="field" type="email" autocomplete="username" required>
      <label class="label" for="ops-password">{{ t('ops.password') }}</label>
      <input id="ops-password" v-model="form.password" class="field" type="password" autocomplete="current-password" required>
      <p v-if="error" class="error-text" role="alert">{{ error }}</p>
      <button type="submit" class="btn primary" :disabled="busy || !form.email || !form.password">{{ t('login.signIn') }}</button>
    </form>
  </main>
</template>

<style scoped>
.ops-auth { min-height: 100vh; display: grid; place-items: start center; padding: var(--space-7) var(--space-4); background: var(--color-bg); font-family: var(--font-family); }
.box { width: 100%; max-width: 400px; display: grid; gap: var(--space-2); box-sizing: border-box; }
h1 { margin: 0; font-size: var(--font-size-title-l); font-weight: 900; }
.btn { justify-self: start; margin-top: var(--space-2); }
</style>
