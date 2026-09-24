<script setup lang="ts">
/**
 * Разделы «Сховища» (docs/v2/34 §5.1, §5.2): файлы, кошик, політики зберігання. Обычные ссылки —
 * работают с клавиатуры и открываются в новой вкладке; политики видит только `storage.policy`.
 */
const { t } = useI18n()
const { hasScope } = useAuth()
const tabs = computed(() => [
  { to: '/admin/settings/storage', label: t('storage.tabs.files'), show: true },
  { to: '/admin/settings/storage/trash', label: t('storage.tabs.trash'), show: true },
  { to: '/admin/settings/storage/policies', label: t('storage.tabs.policies'), show: hasScope('storage.policy') },
].filter(x => x.show))
const route = useRoute()
</script>

<template>
  <nav class="storage-tabs" :aria-label="t('storage.tabs.aria')">
    <NuxtLink
      v-for="tab in tabs"
      :key="tab.to"
      :to="tab.to"
      :class="['chip', { on: route.path === tab.to }]"
      :aria-current="route.path === tab.to ? 'page' : undefined"
    >
      {{ tab.label }}
    </NuxtLink>
  </nav>
</template>

<style scoped>
.storage-tabs { display: flex; flex-wrap: wrap; gap: var(--space-2); margin-bottom: var(--space-4); }
.storage-tabs .chip { text-decoration: none; }
</style>
