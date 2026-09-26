<script setup lang="ts">
/** Заглушка раздела консоли (docs/25 §7 п. 6): экран — в следующем PR, до тех пор — прежняя панель `/ops`. */
definePageMeta({ layout: 'ops', middleware: 'ops-auth' })
const { t } = useI18n()
</script>

<template>
  <section>
    <h1 class="title">{{ t('opsConsole.nav.audit') }}</h1>
    <p class="card">{{ t('opsConsole.soon') }} <NuxtLink to="/ops" class="link">{{ t('opsConsole.nav.legacy') }}</NuxtLink></p>
  </section>
</template>

<style scoped>
.title { margin: 0 0 var(--space-4); font-size: var(--font-size-title-l); font-weight: 900; }
</style>
