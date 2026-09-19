<script setup lang="ts">
definePageMeta({ layout: 'learner' })
const { t } = useI18n()
const { api } = useApi()
const { hasScope } = useAuth()
interface P { id: string, parentId: string | null, title: string, slug: string, status: string, canEdit: boolean, updatedAt: string }
const pages = ref<P[]>([])
const q = ref('')
const hits = ref<{ id: string, title: string, slug: string, snippet: string }[]>([])
const error = ref('')
async function load() { try { pages.value = await api<P[]>(`/wiki${hasScope('wiki.edit') ? '?all=true' : ''}`) } catch (err) { error.value = apiErrorOf(err).message } }
onMounted(load)
let timer: ReturnType<typeof setTimeout> | null = null
watch(q, (v) => { if (timer) clearTimeout(timer); timer = setTimeout(async () => { hits.value = v.trim().length >= 2 ? await api(`/wiki?q=${encodeURIComponent(v)}`) : [] }, 300) })
const children = (parentId: string | null) => pages.value.filter(p => p.parentId === parentId)
</script>
<template>
  <div>
    <div class="head"><h1>{{ t('wiki.title') }}</h1><NuxtLink v-if="hasScope('wiki.edit')" to="/learn/wiki/new" class="chip">+ {{ t('wiki.newPage') }}</NuxtLink></div>
    <p v-if="error" class="error">{{ error }}</p>
    <input v-model="q" class="field" :placeholder="t('wiki.search')">
    <div v-if="hits.length" class="list">
      <NuxtLink v-for="h in hits" :key="h.id" :to="`/learn/wiki/${h.slug}`" class="card"><b>{{ h.title }}</b><!-- eslint-disable-next-line vue/no-v-html -- сниппет собирает ts_headline на сервере, HTML только <b> -->
      <span class="sub" v-html="h.snippet" /></NuxtLink>
    </div>
    <p v-else-if="q.length >= 2" class="sub">{{ t('wiki.nothing') }}</p>
    <ul v-if="!q" class="tree">
      <li v-for="p in children(null)" :key="p.id">
        <NuxtLink :to="`/learn/wiki/${p.slug}`" :class="{ draft: p.status !== 'published' }">{{ p.title }}</NuxtLink>
        <ul v-if="children(p.id).length">
          <li v-for="c in children(p.id)" :key="c.id">
            <NuxtLink :to="`/learn/wiki/${c.slug}`" :class="{ draft: c.status !== 'published' }">{{ c.title }}</NuxtLink>
            <ul v-if="children(c.id).length"><li v-for="g in children(c.id)" :key="g.id"><NuxtLink :to="`/learn/wiki/${g.slug}`" :class="{ draft: g.status !== 'published' }">{{ g.title }}</NuxtLink></li></ul>
          </li>
        </ul>
      </li>
      <li v-if="!pages.length" class="sub">{{ t('wiki.empty') }}</li>
    </ul>
  </div>
</template>
<style scoped>
.head { display: flex; justify-content: space-between; align-items: center; gap: var(--space-2); margin-bottom: var(--space-3); }
h1 { margin: 0; font-weight: 900; }
.chip { font-weight: 700; border: 1px solid var(--color-bg-line); border-radius: var(--radius-pill); padding: var(--space-1) var(--space-3); color: var(--color-ink); text-decoration: none; font-size: var(--font-size-body-s); white-space: nowrap; }
.field { font: inherit; width: 100%; box-sizing: border-box; padding: var(--space-2) var(--space-3); border: 1px solid var(--color-bg-line); border-radius: var(--radius-pill); background: var(--color-bg-soft); margin-bottom: var(--space-3); }
.list { display: grid; gap: var(--space-2); }
.card { background: var(--color-bg-soft); border-radius: var(--radius-l); padding: var(--space-3); display: grid; gap: var(--space-1); color: inherit; text-decoration: none; }
.tree { list-style: none; margin: 0; padding: 0; }
.tree ul { list-style: none; margin: 0; padding-left: var(--space-4); border-left: 2px solid var(--color-bg-line); }
.tree li { padding: var(--space-1) 0; }
.tree a { color: var(--color-ink); font-weight: 700; text-decoration: none; }
.tree a.draft { color: var(--color-ink-muted); font-style: italic; }
.sub { color: var(--color-ink-muted); font-size: var(--font-size-body-s); }
.error { background: var(--color-coral); color: var(--color-coral-deep); padding: var(--space-3); border-radius: var(--radius-m); }
</style>
