<script setup lang="ts">
/**
 * «Звідки взявся мій відсоток» — свій індекс залученості (docs/v2/38 §5.3, §2: «Видеть свою ленту
 * активности, свой рейтинг и расшифровку» — каждому сотруднику, без скоупа). Не баллы рейтинга:
 * они — на «Моя історія навчання».
 */
definePageMeta({ layout: 'learner' })
const { t } = useI18n()
const { me } = useAuth()
const personId = computed(() => me.value?.user.id ?? '')
</script>

<template>
  <div class="page">
    <NuxtLink to="/learn/profile" class="back">← {{ t('engagement.backProfile') }}</NuxtLink>
    <EngagementBreakdown v-if="personId" :person-id="personId" />
  </div>
</template>

<style scoped>
.page { display: grid; gap: var(--space-3); }
.back { color: var(--color-ink-muted); text-decoration: none; font-size: var(--font-size-body-s); }
</style>
