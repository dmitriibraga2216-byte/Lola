<script setup lang="ts">
const { t } = useI18n()
const { me, logout } = useAuth()
</script>

<template>
  <main class="landing">
    <h1>{{ t('app.name') }}</h1>
    <p>{{ t('app.tagline') }}</p>
    <template v-if="me">
      <p class="who">{{ t('home.signedInAs', { name: me.user.fullName }) }}</p>
      <p class="who muted">{{ t('home.space', { name: me.tenant.name }) }}</p>
      <button class="logout" @click="logout">{{ t('home.logout') }}</button>
    </template>
  </main>
</template>

<style scoped>
.landing {
  min-height: 100dvh;
  display: grid;
  place-content: center;
  text-align: center;
  gap: var(--space-2);
  background: var(--color-bg);
  color: var(--color-ink);
  font-family: var(--font-family);
}

h1 {
  font-weight: 900;
  font-size: var(--font-size-display);
  margin: 0;
}

p {
  margin: 0;
  color: var(--color-ink-muted);
}

.who {
  color: var(--color-ink);
}

.muted {
  color: var(--color-ink-faint);
}

.logout {
  margin-top: var(--space-4);
  justify-self: center;
  font: inherit;
  font-weight: 800;
  border: 1px solid var(--color-bg-line);
  background: var(--color-bg-soft);
  color: var(--color-ink);
  border-radius: var(--radius-pill);
  padding: var(--space-2) var(--space-5);
  cursor: pointer;
}
</style>
