<script setup lang="ts">
/** Урок из поиска: показываем материал в режиме чтения (без прогресса — это справка, не прохождение). */
import type { ContentBlock } from '../../../../../shared/schemas/content'

definePageMeta({ layout: 'learner' })
const { t } = useI18n()
const { api } = useApi()
interface Rating { count: number, average: number | null, myValue: number | null }
const id = useRoute().params.id as string
const res = ref<{ id: string, title: string, body: ContentBlock[], rating: Rating } | null>(null)
const error = ref('')
onMounted(async () => {
  try {
    res.value = await api<{ id: string, title: string, body: ContentBlock[], rating: Rating }>(`/knowledge/resource/${id}`)
  }
  catch (err) { error.value = apiErrorOf(err).message }
})
</script>

<template>
  <div v-if="res">
    <NuxtLink to="/learn/knowledge" class="back">← {{ t('kb.title') }}</NuxtLink>
    <span class="kind">{{ t('kb.kind.lesson') }}</span>
    <h1>{{ res.title }}</h1>
    <LessonBlocks :blocks="res.body" :blocks-state="{}" readonly />
    <ContentRating content-type="resource" :content-id="res.id" :initial="res.rating" />
  </div>
  <p v-else-if="error" class="error">{{ error }}</p>
</template>

<style scoped>
.back { color: var(--color-ink-muted); text-decoration: none; font-size: var(--font-size-body-s); }
.kind { display: inline-block; margin-top: var(--space-2); font-size: var(--font-size-body-s); font-weight: 700; border-radius: var(--radius-pill); padding: 1px var(--space-2); background: var(--color-sun); color: var(--color-sun-ink); }
h1 { margin: var(--space-2) 0 var(--space-4); font-weight: 900; }
.error { color: var(--color-coral-ink); }
</style>
