<script setup lang="ts">
import type { ContentBlock } from '../../../../shared/schemas/content'
const { formatShortDate } = useFormat()

definePageMeta({ layout: 'learner' })
const { t } = useI18n()
const { api } = useApi()
const { hasScope } = useAuth()
const id = useRoute().params.id as string
interface Rating { count: number, average: number | null, myValue: number | null }
interface A { id: string, title: string, summary: string | null, body: ContentBlock[], tags: string[], updatedAt: string, helpfulCount: number, notHelpfulCount: number, myFeedback: boolean | null, related: { id: string, title: string, slug: string }[], relatedCourseItems: { id: string, title: string }[], attachments: { mediaId: string, name: string }[], ownerName: string | null, reviewAt: string | null, reviewConfirmedAt: string | null, needsReview: boolean, rating: Rating }
const article = ref<A | null>(null)
const error = ref('')
const notice = ref('')
const comment = ref('')
const askComment = ref(false)
onMounted(async () => {
  try { article.value = await api(`/knowledge/${id}`) }
  catch (err) { error.value = apiErrorOf(err).message }
})
async function vote(helpful: boolean) {
  if (!article.value) return
  if (!helpful && !askComment.value) { askComment.value = true; return }
  try {
    const r = await api<{ helpful: number, notHelpful: number }>(`/knowledge/${id}/feedback`, { method: 'POST', body: { helpful, comment: comment.value || undefined } })
    article.value.myFeedback = helpful; article.value.helpfulCount = r.helpful; article.value.notHelpfulCount = r.notHelpful; askComment.value = false; notice.value = t('kb.thanks')
  }
  catch (err) { error.value = apiErrorOf(err).message }
}
async function confirmActual() {
  try { const r = await api<{ reviewAt: string }>(`/knowledge/${id}/confirm-actual`, { method: 'POST' }); if (article.value) { article.value.reviewAt = r.reviewAt; article.value.needsReview = false; article.value.reviewConfirmedAt = new Date().toISOString() } notice.value = t('common.saved') }
  catch (err) { error.value = apiErrorOf(err).message }
}
const fmt = (d: string | null) => d ? formatShortDate(new Date(d)) : '—'
</script>

<template>
  <div v-if="article">
    <NuxtLink to="/learn/knowledge" class="back">← {{ t('kb.title') }}</NuxtLink>
    <p v-if="article.needsReview" class="warn" role="status">⚠ {{ t('kb.needsReview') }}</p>
    <h1>{{ article.title }}</h1>
    <p v-if="article.summary" class="summary">{{ article.summary }}</p>
    <LessonBlocks :blocks="article.body" :blocks-state="{}" readonly />
    <ul v-if="article.attachments?.length" class="list">
      <li v-for="a in article.attachments" :key="a.mediaId"><a :href="`/api/v1/media/${a.mediaId}?redirect=1`" target="_blank" rel="noopener" class="link">📎 {{ a.name }}</a></li>
    </ul>
    <p class="sub">{{ article.tags.join(' · ') }}</p>
    <ContentRating content-type="knowledge_article" :content-id="article.id" :initial="article.rating" />
    <p v-if="error" class="error" role="alert">{{ error }}</p>
    <p v-if="notice" class="notice" role="status">{{ notice }}</p>

    <section class="card">
      <b>{{ t('kb.helpfulQ') }}</b>
      <div class="row">
        <button :class="['chip', { on: article.myFeedback === true }]" @click="vote(true)">👍 {{ t('kb.yes') }} <span class="sub">{{ article.helpfulCount }}</span></button>
        <button :class="['chip', { on: article.myFeedback === false }]" @click="vote(false)">👎 {{ t('kb.no') }} <span class="sub">{{ article.notHelpfulCount }}</span></button>
      </div>
      <div v-if="askComment" class="row"><input v-model="comment" class="field" :placeholder="t('kb.whatMissing')" maxlength="1000"><button class="chip" @click="vote(false)">OK</button></div>
    </section>

    <section v-if="article.relatedCourseItems?.length" class="card">
      <b>{{ t('kb.learnOnTopic') }}</b>
      <ul class="list"><li v-for="c in article.relatedCourseItems" :key="c.id"><NuxtLink :to="`/learn/catalog?course=${c.id}`" class="link">{{ c.title }}</NuxtLink></li></ul>
    </section>
    <section v-if="article.related?.length" class="card">
      <b>{{ t('kb.related') }}</b>
      <ul class="list"><li v-for="r in article.related" :key="r.id"><NuxtLink :to="`/learn/knowledge/${r.id}`" class="link">{{ r.title }}</NuxtLink></li></ul>
    </section>

    <p class="sub">{{ t('kb.owner') }}: {{ article.ownerName ?? '—' }} · {{ t('kb.reviewedAt') }}: {{ fmt(article.reviewConfirmedAt ?? article.updatedAt) }}<template v-if="article.reviewAt"> · {{ t('kb.reviewDue') }}: {{ article.reviewAt }}</template></p>
    <div v-if="hasScope('knowledge.manage')" class="row">
      <NuxtLink :to="`/admin/knowledge/${article.id}`" class="chip">{{ t('common.edit') }}</NuxtLink>
      <button class="chip" @click="confirmActual">{{ t('kb.confirmActual') }}</button>
    </div>
  </div>
  <p v-else-if="error" class="error">{{ error }}</p>
</template>

<style scoped>
.back { color: var(--color-ink-muted); text-decoration: none; font-size: var(--font-size-body-s); }
h1 { margin: var(--space-2) 0 var(--space-2); font-weight: 900; }
.summary { color: var(--color-ink-muted); margin: 0 0 var(--space-4); }
.sub { color: var(--color-ink-faint); font-size: var(--font-size-body-s); margin-top: var(--space-3); }
.warn { background: var(--color-sun); color: var(--color-sun-ink); border-radius: var(--radius-m); padding: var(--space-2) var(--space-3); font-weight: 700; }
.card { background: var(--color-bg-soft); border-radius: var(--radius-m); padding: var(--space-3); margin-top: var(--space-3); display: grid; gap: var(--space-2); }
.row { display: flex; gap: var(--space-2); flex-wrap: wrap; align-items: center; }
.chip { font: inherit; font-weight: 700; border: 1px solid var(--color-bg-line); background: transparent; color: var(--color-ink); border-radius: var(--radius-pill); padding: var(--space-1) var(--space-3); cursor: pointer; text-decoration: none; min-height: 44px; }
.chip.on { background: var(--color-teal); border-color: var(--color-teal); color: var(--color-teal-deep); }
.field { font: inherit; border: 1px solid var(--color-bg-line); border-radius: var(--radius-s); padding: var(--space-2); background: var(--color-bg); color: var(--color-ink); flex: 1; min-width: 160px; }
.list { list-style: none; margin: 0; padding: 0; display: grid; gap: var(--space-1); }
.link { color: var(--color-teal-ink); font-weight: 700; text-decoration: none; }
.error { color: var(--color-coral-ink); }
.notice { color: var(--color-teal-ink); }
</style>
