<script setup lang="ts">
import type { ContentBlock } from '../../../../shared/schemas/content'

definePageMeta({ layout: 'learner' })
const { t } = useI18n()
const { api } = useApi()
const id = useRoute().params.id as string
const article = ref<{ title: string, summary: string | null, body: ContentBlock[], tags: string[], updatedAt: string } | null>(null)
const error = ref('')
onMounted(async () => {
  try { article.value = await api(`/knowledge/${id}`) }
  catch (err) { error.value = apiErrorOf(err).message }
})
</script>

<template>
  <div v-if="article">
    <NuxtLink to="/learn/knowledge" class="back">← {{ t('kb.title') }}</NuxtLink>
    <h1>{{ article.title }}</h1>
    <p v-if="article.summary" class="summary">{{ article.summary }}</p>
    <LessonBlocks :blocks="article.body" :blocks-state="{}" readonly />
    <p class="sub">{{ article.tags.join(' · ') }}</p>
  </div>
  <p v-else-if="error" class="error">{{ error }}</p>
</template>

<style scoped>
.back { color: var(--color-ink-muted); text-decoration: none; font-size: var(--font-size-body-s); }
h1 { margin: var(--space-2) 0 var(--space-2); font-weight: 900; }
.summary { color: var(--color-ink-muted); margin: 0 0 var(--space-4); }
.sub { color: var(--color-ink-faint); font-size: var(--font-size-body-s); margin-top: var(--space-4); }
.error { color: var(--color-coral-ink); }
</style>
