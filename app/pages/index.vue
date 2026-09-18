<script setup lang="ts">
const { t } = useI18n()
</script>

<template>
  <main class="landing">
    <h1>{{ t('app.name') }}</h1>
    <p>{{ t('app.tagline') }}</p>
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
</style>
