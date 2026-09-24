<script setup lang="ts">
import type { ContentBlock } from '../../../../shared/schemas/content'
const { formatDateTime, formatTime } = useFormat()
definePageMeta({ layout: 'admin', middleware: 'admin-scope', requiredScope: 'knowledge.manage' })
const { t } = useI18n()
const { api, apiRaw } = useApi()
const id = useRoute().params.id as string
interface A { id: string, title: string, summary: string | null, body: ContentBlock[], tags: string[], status: string, version: number, ownerId: string | null, reviewAt: string | null, relatedCourses: string[], relatedArticles: string[], attachments: { mediaId: string, name: string }[], visibility: { scope: string, audience?: unknown }, needsReview: boolean, helpfulCount: number, notHelpfulCount: number }
const article = ref<A | null>(null)
const draft = reactive({ title: '', summary: '', body: [] as ContentBlock[], tags: '', ownerId: '', reviewAt: '', relatedCourses: [] as string[], relatedArticles: [] as string[], attachments: [] as { mediaId: string, name: string }[], scope: 'tenant' as 'tenant' | 'audience', positionIds: [] as string[], locationIds: [] as string[] })
const refs = reactive<{ people: { id: string, fullName: string }[], courses: { id: string, title: string }[], articles: { id: string, title: string }[], positions: { id: string, name: string }[], locations: { id: string, name: string }[] }>({ people: [], courses: [], articles: [], positions: [], locations: [] })
const { upload } = useMediaUpload()
async function attach(e: Event) { const f = (e.target as HTMLInputElement).files?.[0]; if (!f) return; try { const mediaId = await upload(f, f.name, 'lesson_attachment'); draft.attachments.push({ mediaId, name: f.name }) } catch (err) { error.value = apiErrorOf(err).message } }
const revisions = ref<{ version: number, comment: string | null, createdAt: string }[]>([])
const savedAt = ref('')
const error = ref('')
async function load() {
  try {
    article.value = await api<A>(`/knowledge/${id}`)
    const aud = (article.value.visibility?.audience ?? null) as { rules?: { type: string, ids?: string[] }[] } | null
    Object.assign(draft, { title: article.value.title, summary: article.value.summary ?? '', body: JSON.parse(JSON.stringify(article.value.body)), tags: article.value.tags.join(', '), ownerId: article.value.ownerId ?? '', reviewAt: article.value.reviewAt ?? '', relatedCourses: [...(article.value.relatedCourses ?? [])], relatedArticles: [...(article.value.relatedArticles ?? [])], attachments: [...(article.value.attachments ?? [])], scope: article.value.visibility?.scope === 'audience' ? 'audience' : 'tenant', positionIds: aud?.rules?.find(r => r.type === 'position')?.ids ?? [], locationIds: aud?.rules?.find(r => r.type === 'location')?.ids ?? [] })
    revisions.value = await api(`/knowledge/${id}/revisions`)
    if (!refs.courses.length) {
      try {
        const [people, courses, articles, positions, locations] = await Promise.all([apiRaw<{ data: { id: string, fullName: string }[] }>('/people?limit=100').catch(() => null), api<{ id: string, title: string, status: string }[]>('/courses'), api<{ id: string, title: string }[]>('/knowledge'), api<{ id: string, name: string }[]>('/refs/positions'), api<{ id: string, name: string }[]>('/refs/locations')])
        Object.assign(refs, { people: people?.data ?? [], courses: courses.filter(c => c.status === 'published'), articles: articles.filter(a => a.id !== id), positions, locations })
      }
      catch { /* справочники не обязательны */ }
    }
  } catch (err) { error.value = apiErrorOf(err).message }
}
onMounted(load)
let timer: ReturnType<typeof setTimeout>
watch(() => [draft.title, draft.summary, draft.body, draft.tags, draft.ownerId, draft.reviewAt, draft.relatedCourses, draft.relatedArticles, draft.attachments, draft.scope, draft.positionIds, draft.locationIds], () => { clearTimeout(timer); timer = setTimeout(save, 1500) }, { deep: true })
async function save() {
  if (!article.value) return
  try {
    const rules = [...(draft.positionIds.length ? [{ type: 'position', ids: draft.positionIds }] : []), ...(draft.locationIds.length ? [{ type: 'location', ids: draft.locationIds }] : [])]
    await api(`/knowledge/${id}`, { method: 'PATCH', body: { title: draft.title, summary: draft.summary, body: draft.body, tags: draft.tags.split(',').map(s => s.trim()).filter(Boolean), ownerId: draft.ownerId || undefined, reviewAt: draft.reviewAt || null, relatedCourses: draft.relatedCourses, relatedArticles: draft.relatedArticles, attachments: draft.attachments, visibility: draft.scope === 'audience' && rules.length ? { scope: 'audience', audience: { rules, match: 'any' } } : { scope: 'tenant' } } })
    savedAt.value = formatTime(new Date(), { hour: '2-digit', minute: '2-digit' })
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
    <section class="meta">
      <label>{{ t('kb.owner') }} *<select v-model="draft.ownerId"><option value="">—</option><option v-for="p in refs.people" :key="p.id" :value="p.id">{{ p.fullName }}</option></select></label>
      <label>{{ t('kb.reviewDue') }}<input v-model="draft.reviewAt" type="date"></label>
      <label>{{ t('kb.visibility') }}<select v-model="draft.scope"><option value="tenant">{{ t('kb.visAll') }}</option><option value="audience">{{ t('kb.visAudience') }}</option></select></label>
      <template v-if="draft.scope === 'audience'">
        <label>{{ t('person.position') }}<select v-model="draft.positionIds" multiple size="4"><option v-for="p in refs.positions" :key="p.id" :value="p.id">{{ p.name }}</option></select></label>
        <label>{{ t('person.location') }}<select v-model="draft.locationIds" multiple size="4"><option v-for="l in refs.locations" :key="l.id" :value="l.id">{{ l.name }}</option></select></label>
      </template>
      <label>{{ t('kb.learnOnTopic') }}<select v-model="draft.relatedCourses" multiple size="4"><option v-for="c in refs.courses" :key="c.id" :value="c.id">{{ c.title }}</option></select></label>
      <label>{{ t('kb.related') }}<select v-model="draft.relatedArticles" multiple size="4"><option v-for="a in refs.articles" :key="a.id" :value="a.id">{{ a.title }}</option></select></label>
      <label>{{ t('kb.attachments') }}<input type="file" @change="attach"></label>
      <ul class="att"><li v-for="(a, i) in draft.attachments" :key="a.mediaId">📎 {{ a.name }} <button class="chip" @click="draft.attachments.splice(i, 1)">×</button></li></ul>
      <p class="sub">👍 {{ article.helpfulCount }} · 👎 {{ article.notHelpfulCount }}<span v-if="article.needsReview"> · ⚠ {{ t('kb.needsReview') }}</span></p>
    </section>
    <details class="revs"><summary>{{ t('kb.revisions', { n: revisions.length }) }}</summary>
      <ul><li v-for="r in revisions" :key="r.version">v{{ r.version }} · {{ formatDateTime(new Date(r.createdAt)) }}{{ r.comment ? ` — ${r.comment}` : '' }}</li></ul>
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
.meta { display: grid; grid-template-columns: repeat(auto-fill, minmax(220px, 1fr)); gap: var(--space-2) var(--space-3); background: var(--color-bg-soft); border-radius: var(--radius-m); padding: var(--space-3); margin-top: var(--space-3); }
.meta label { display: grid; gap: var(--space-1); font-size: var(--font-size-body-s); color: var(--color-ink-muted); }
.meta select, .meta input { font: inherit; border: 1px solid var(--color-bg-line); border-radius: var(--radius-s); padding: var(--space-1) var(--space-2); background: var(--color-bg); color: var(--color-ink); min-width: 0; }
.att { list-style: none; margin: 0; padding: 0; grid-column: 1 / -1; display: flex; gap: var(--space-2); flex-wrap: wrap; }
</style>
