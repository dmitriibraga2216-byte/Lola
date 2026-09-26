<script setup lang="ts">
/** Приглашение оператора (docs/25 §7 п. 7): задать пароль по ссылке из письма; дальше — вход и 2FA. */
definePageMeta({ layout: false })
const { t } = useI18n()
const route = useRoute()
const token = computed(() => String(route.query.t ?? ''))
const who = ref<{ email: string, fullName: string } | null>(null)
const password = ref('')
const repeat = ref('')
const error = ref('')
const done = ref(false)
const busy = ref(false)
const MIN = 12

onMounted(async () => {
  try { who.value = (await $fetch<{ data: { email: string, fullName: string } }>(`/api/v1/platform/invite/${encodeURIComponent(token.value)}`)).data }
  catch (err) { error.value = apiErrorOf(err).message }
})

const ready = computed(() => password.value.length >= MIN && password.value === repeat.value)
async function submit() {
  if (!ready.value || busy.value) return
  error.value = ''
  busy.value = true
  try {
    await $fetch('/api/v1/platform/invite/accept', { method: 'POST', body: { token: token.value, password: password.value } })
    done.value = true
  }
  catch (err) { error.value = apiErrorOf(err).message }
  finally { busy.value = false }
}
</script>

<template>
  <main class="ops-auth">
    <div class="card box">
      <h1>{{ t('opsConsole.invite.title') }}</h1>
      <template v-if="done">
        <p>{{ t('opsConsole.invite.done') }}</p>
        <NuxtLink to="/ops/login" class="btn primary">{{ t('login.signIn') }}</NuxtLink>
      </template>
      <form v-else-if="who" class="grid" @submit.prevent="submit">
        <p class="muted">{{ t('opsConsole.invite.for', { name: who.fullName, email: who.email }) }}</p>
        <label class="label" for="ops-pw">{{ t('opsConsole.invite.password', { n: MIN }) }}</label>
        <input id="ops-pw" v-model="password" class="field" type="password" autocomplete="new-password" required>
        <label class="label" for="ops-pw2">{{ t('opsConsole.invite.repeat') }}</label>
        <input id="ops-pw2" v-model="repeat" class="field" type="password" autocomplete="new-password" required>
        <p v-if="repeat && repeat !== password" class="error-text">{{ t('opsConsole.invite.mismatch') }}</p>
        <p v-if="error" class="error-text" role="alert">{{ error }}</p>
        <button type="submit" class="btn primary" :disabled="!ready || busy">{{ t('opsConsole.invite.save') }}</button>
      </form>
      <p v-else-if="error" class="error-text" role="alert">{{ error }}</p>
    </div>
  </main>
</template>

<style scoped>
.ops-auth { min-height: 100vh; display: grid; place-items: start center; padding: var(--space-7) var(--space-4); background: var(--color-bg); font-family: var(--font-family); }
.box { width: 100%; max-width: 420px; display: grid; gap: var(--space-3); box-sizing: border-box; }
.grid { display: grid; gap: var(--space-2); }
h1 { margin: 0; font-size: var(--font-size-title-l); font-weight: 900; }
.btn { justify-self: start; }
</style>
