<script setup lang="ts">
/**
 * База знань (мокап Knowledge, docs/21 §14.1): «Мої закладки» первым пунктом, поиск по ресурсам, новинам
 * і оголошенням, чипы Усі · Ресурси · Новини · Оголошення, «Переглядів · Оцінок», закладка на результате.
 */
definePageMeta({ layout: 'learner' })

const { t } = useI18n()
const { api } = useApi()

type Source = 'all' | 'resources' | 'news' | 'notices'
interface Hit { kind: 'article' | 'lesson' | 'question' | 'news' | 'notice', id: string, title: string, snippet: string, score: number, bookmarked?: boolean, views?: number }
interface Bookmark { contentType: 'resource' | 'article' | 'news' | 'notice', contentId: string, title: string }

const q = ref('')
const source = ref<Source>('all')
const hits = ref<Hit[]>([])
const bookmarks = ref<Bookmark[]>([])
const showBookmarks = ref(false)
const searched = ref(false)
const loading = ref(false)
const SOURCES: Source[] = ['all', 'resources', 'news', 'notices']

async function loadBookmarks() { try { bookmarks.value = await api<Bookmark[]>('/knowledge/bookmarks') } catch { bookmarks.value = [] } }
onMounted(loadBookmarks)

let timer: ReturnType<typeof setTimeout>
async function run() {
  if (q.value.trim().length < 2) { hits.value = []; searched.value = false; return }
  loading.value = true
  try { hits.value = await api<Hit[]>('/knowledge/search', { query: { q: q.value, in: source.value } }); searched.value = true }
  finally { loading.value = false }
}
watch(q, () => { clearTimeout(timer); timer = setTimeout(run, 300) })
watch(source, run)

const linkOf = (kind: Hit['kind'] | Bookmark['contentType'], id: string) => kind === 'article' ? `/learn/knowledge/${id}` : kind === 'lesson' || kind === 'resource' ? `/learn/knowledge/lesson/${id}` : kind === 'news' ? '/learn/news' : kind === 'notice' ? `/learn/notices/${id}` : '#'
const bookmarkType = (kind: Hit['kind']): Bookmark['contentType'] | null => kind === 'lesson' ? 'resource' : kind === 'question' ? null : kind
async function toggle(h: Hit) {
  const type = bookmarkType(h.kind)
  if (!type) return
  try { const r = await api<{ bookmarked: boolean }>(`/knowledge/${h.id}/bookmark`, { method: 'POST', body: { contentType: type } }); h.bookmarked = r.bookmarked; await loadBookmarks() } catch { /* ошибка сети — закладка не изменится */ }
}
</script>

<template>
  <div>
    <h1>{{ t('kb.title') }}</h1>
    <input v-model="q" class="search" type="search" :placeholder="t('kb.searchAll')" autofocus>
    <div class="chips" role="tablist">
      <button v-for="s in SOURCES" :key="s" role="tab" :class="['chip', { on: source === s && !showBookmarks }]" :aria-selected="source === s && !showBookmarks" @click="source = s; showBookmarks = false">{{ t(`kb.source.${s}`) }}</button>
      <button :class="['chip', 'outline', { on: showBookmarks }]" @click="showBookmarks = !showBookmarks">★ {{ t('kb.bookmarks') }} · {{ bookmarks.length }}</button>
    </div>
    <div v-if="showBookmarks" class="hits">
      <NuxtLink v-for="b in bookmarks" :key="`${b.contentType}:${b.contentId}`" :to="linkOf(b.contentType, b.contentId)" class="hit">
        <span :class="['kind', b.contentType]">{{ t(`kb.kind.${b.contentType === 'resource' ? 'lesson' : b.contentType}`) }}</span>
        <span class="hit-title">{{ b.title }}</span>
      </NuxtLink>
      <p v-if="!bookmarks.length" class="empty">{{ t('kb.noBookmarks') }}</p>
    </div>
    <template v-else>
      <p v-if="loading" class="sub">{{ t('common.loading') }}</p>
      <p v-else-if="searched && hits.length === 0" class="empty">{{ t('kb.nothing') }}</p>
      <div class="hits">
        <div v-for="h in hits" :key="`${h.kind}:${h.id}`" class="hit">
          <span :class="['kind', h.kind]">{{ t(`kb.kind.${h.kind}`) }}</span>
          <NuxtLink :to="linkOf(h.kind, h.id)" class="hit-title">{{ h.title }}</NuxtLink>
          <!-- eslint-disable-next-line vue/no-v-html -- ts_headline из санитизированного plain_text, только <b> -->
          <span class="snippet" v-html="h.snippet" />
          <span class="foot">
            <span v-if="h.views !== undefined" class="sub">{{ t('notices.views', { n: h.views }) }}</span>
            <button v-if="bookmarkType(h.kind)" :class="['chip', { on: h.bookmarked }]" :aria-pressed="!!h.bookmarked" @click="toggle(h)">★ {{ h.bookmarked ? t('kb.bookmarked') : t('kb.bookmark') }}</button>
          </span>
        </div>
      </div>
    </template>
  </div>
</template>

<style scoped>
h1 { margin: 0 0 var(--space-3); font-weight: 900; }
.search { width: 100%; box-sizing: border-box; font: inherit; font-size: var(--font-size-title-l); border: 2px solid var(--color-bg-line); border-radius: var(--radius-pill); padding: var(--space-3) var(--space-5); background: var(--color-bg-soft); color: var(--color-ink); margin-bottom: var(--space-3); }
.chips { margin-bottom: var(--space-3); }
.hits { display: grid; gap: var(--space-2); }
.hit { display: grid; gap: var(--space-1); background: var(--color-bg-soft); border-radius: var(--radius-m); padding: var(--space-3) var(--space-4); text-decoration: none; color: var(--color-ink); }
.kind { justify-self: start; font-size: var(--font-size-body-s); font-weight: 700; border-radius: var(--radius-pill); padding: 1px var(--space-2); background: var(--color-bg-line-soft); color: var(--color-ink-muted); }
.kind.lesson, .kind.resource { background: var(--color-sun); color: var(--color-sun-ink); }
.kind.notice { background: var(--color-coral); color: var(--color-coral-deep); }
.kind.news { background: var(--color-teal); color: var(--color-teal-deep); }
.hit-title { font-weight: 800; color: var(--color-ink); text-decoration: none; }
.snippet { font-size: var(--font-size-body-s); color: var(--color-ink-muted); }
.snippet :deep(b) { color: var(--color-ink); background: color-mix(in srgb, var(--color-sun) 40%, transparent); border-radius: 3px; padding: 0 2px; }
.foot { display: flex; justify-content: space-between; align-items: center; gap: var(--space-2); }
.sub, .empty { color: var(--color-ink-faint); }
.empty { text-align: center; padding: var(--space-4); }
</style>
