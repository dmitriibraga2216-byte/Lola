<script setup lang="ts">
import type { ContentBlock } from '../../../../shared/schemas/content'
definePageMeta({ layout: 'admin', middleware: 'admin-scope', requiredScope: 'knowledge.manage' })
const { t } = useI18n()
const { api } = useApi()
const id = useRoute().params.id as string
interface A { id: string, title: string, summary: string | null, body: ContentBlock[], tags: string[], status: string, version: number }
const article = ref<A | null>(null)
const draft = reactive({ title: '', summary: '', body: [] as ContentBlock[], tags: '' })
const revisions = ref<{ version: number, comment: string | null, createdAt: string }[]>([])
const savedAt = ref('')
const error = ref('')
async function load() {
  try {
    article.value = await api<A>(`/knowledge/${id}`)
    Object.assign(draft, { title: article.value.title, summary: article.value.summary ?? '', body: JSON.parse(JSON.stringify(article.value.body)), tags: article.value.tags.join(', ') })
    revisions.value = await api(`/knowledge/${id}/revisions`)
  } catch (err) { error.value = apiErrorOf(err).message }
}
onMounted(load)
let timer: ReturnType<typeof setTimeout>
watch(() => [draft.title, draft.summary, draft.body, draft.tags], () => { clearTimeout(timer); timer = setTimeout(save, 1500) }, { deep: true })
async function save() {
  if (!article.value) return
  try {
    await api(`/knowledge/${id}`, { method: 'PATCH', body: { title: draft.title, summary: draft.summary, body: draft.body, tags: draft.tags.split(',').map(s => s.trim()).filter(Boolean) } })
    savedAt.value = new Date().toLocaleTimeString('uk', { hour: '2-digit', minute: '2-digit' })
  } catch (err) { error.value = apiErrorOf(err).message }
}
async function setStatus(status: string) { await save(); await api(`/knowledge/${id}`, { method: 'PATCH', body: { status } }); await load() }
</script>
<template>
  <div v-if="article">
    <NuxtLink to="/admin/knowledge" class="back">← {{ t('admin.nav.knowledge') }}</NuxtLink>
    <header class="head">
      <input v-model="draft.title" class="title-input">
      <span :class="['badge', article.status]">{{ t(`course.status.${article.status}`) }}</span>
      <span class="sub">v{{ article.version }}{{ savedAt ? ` · ${t('course.savedAt', { time: savedAt })}` : '' }}</span>
      <button v-if="article.status !== 'published'" class="primary" @click="setStatus('published')">{{ t('course.publish') }}</button>
      <button v-else class="chip" @click="setStatus('draft')">{{ t('kb.unpublish') }}</button>
    </header>
    <p v-if="error" class="error">{{ error }}</p>
    <input v-model="draft.summary" class="field" :placeholder="t('kb.summary')">
    <input v-model="draft.tags" class="field" :placeholder="t('kb.tags')">
    <BlockEditor v-model="draft.body" />
    <details class="revs"><summary>{{ t('kb.revisions', { n: revisions.length }) }}</summary>
      <ul><li v-for="r in revisions" :key="r.version">v{{ r.version }} · {{ new Date(r.createdAt).toLocaleString('uk') }}{{ r.comment ? ` — ${r.comment}` : '' }}</li></ul>
    </details>
  </div>
  <p v-else-if="error" class="error">{{ error }}</p>
</template>
<style scoped>
.back { color: var(--color-ink-muted); text-decoration: none; font-size: var(--font-size-body-s); }
.head { display: flex; align-items: center; gap: var(--space-3); flex-wrap: wrap; margin: var(--space-2) 0 var(--space-3); }
.title-input { flex: 1; min-width: 240px; font: inherit; font-size: var(--font-size-title-l); font-weight: 800; border: 1px solid var(--color-bg-line); border-radius: var(--radius-s); padding: var(--space-2) var(--space-3); background: var(--color-bg-soft); color: var(--color-ink); }
.field { display: block; width: 100%; box-sizing: border-box; font: inherit; border: 1px solid var(--color-bg-line); border-radius: var(--radius-s); padding: var(--space-2) var(--space-3); background: var(--color-bg-soft); color: var(--color-ink); margin-bottom: var(--space-3); }
.primary { font: inherit; font-weight: 800; border: none; background: var(--color-sun); color: var(--color-ink); border-radius: var(--radius-pill); padding: var(--space-2) var(--space-4); cursor: pointer; }
.chip { font: inherit; font-weight: 700; border: 1px solid var(--color-bg-line); background: transparent; color: var(--color-ink-muted); border-radius: var(--radius-pill); padding: var(--space-1) var(--space-3); cursor: pointer; }
.badge { font-size: var(--font-size-body-s); font-weight: 700; border-radius: var(--radius-pill); padding: 2px var(--space-3); background: var(--color-bg-line-soft); }
.badge.published { background: var(--color-teal); color: var(--color-teal-deep); }
.badge.draft { background: var(--color-sun); color: var(--color-sun-ink); }
.revs { margin-top: var(--space-4); font-size: var(--font-size-body-s); color: var(--color-ink-muted); }
.revs summary { cursor: pointer; }
.sub { font-size: var(--font-size-body-s); color: var(--color-ink-faint); }
.error { color: var(--color-coral-ink); }
</style>
