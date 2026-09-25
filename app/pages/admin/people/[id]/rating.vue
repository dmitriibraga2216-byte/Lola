<script setup lang="ts">
/**
 * Расшифровка індексу залученості человека для руководителя и HR (docs/v2/38 §5.3, §7.3):
 * та же цифра, слагаемые и динамика, что человек видит о себе. Права решает сервер
 * (`person.rating.view_others` в области текущей точки человека) — без них экран говорит
 * «Немає доступу…», а не показывает пустоту.
 */
definePageMeta({ layout: 'admin', middleware: 'admin-scope' })
const { t } = useI18n()
const route = useRoute()
const id = computed(() => route.params.id as string)
</script>

<template>
  <div class="page">
    <NuxtLink :to="`/admin/people/${id}`" class="back">← {{ t('engagement.backCard') }}</NuxtLink>
    <EngagementBreakdown :person-id="id" />
  </div>
</template>

<style scoped>
.page { display: grid; gap: var(--space-3); }
.back { color: var(--color-ink-muted); text-decoration: none; font-size: var(--font-size-body-s); }
</style>
