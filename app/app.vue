<script setup lang="ts">
const impersonated = useCookie('lola_impersonated')
</script>

<template>
  <div v-if="impersonated" class="impersonation-bar">
    Режим «від імені» · оператор {{ impersonated }}
  </div>
  <NuxtPage />
</template>

<style>
.impersonation-bar {
  position: sticky;
  top: 0;
  z-index: 100;
  background: var(--color-coral);
  color: var(--color-coral-deep);
  font-family: var(--font-family);
  font-weight: 800;
  font-size: var(--font-size-body-s);
  text-align: center;
  padding: var(--space-1) var(--space-3);
}
</style>
