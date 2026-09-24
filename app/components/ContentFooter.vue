<script setup lang="ts">
/**
 * «Колонтитул» материалов (docs/v2/39 П-24.1; второй эталон: «Відображати назву та логотип
 * компанії в контенті під час проходження»): внизу урока, теста, практикума и статьи базы знаний
 * — название пространства и его логотип. Включается в «Налаштування → Простір»; выключен —
 * компонент ничего не рисует.
 */
const { me } = useAuth()
const tenant = computed(() => me.value?.tenant ?? null)
</script>

<template>
  <div v-if="tenant?.contentFooter" class="content-footer" data-testid="content-footer">
    <img v-if="tenant.logoMediaId" :src="`/api/v1/media/${tenant.logoMediaId}?redirect=1&variant=320`" :alt="tenant.name" class="logo">
    <span class="name">{{ tenant.name }}</span>
  </div>
</template>

<style scoped>
.content-footer {
  display: flex;
  align-items: center;
  justify-content: center;
  gap: var(--space-2);
  margin: var(--space-5) 0 var(--space-3);
  padding-top: var(--space-3);
  border-top: 1px solid var(--color-bg-line-soft);
  color: var(--color-ink-muted);
  font-size: var(--font-size-body-s);
  font-weight: 700;
}
.logo { height: 24px; width: auto; max-width: 120px; object-fit: contain; }
</style>
