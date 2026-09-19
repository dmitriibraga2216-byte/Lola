<script setup lang="ts">
definePageMeta({ layout: 'learner' })

const { t } = useI18n()
const { api } = useApi()

interface Hit { kind: 'article' | 'lesson', id: string, title: string, snippet: string, score: number }

const q = ref('')
const hits = ref<Hit[]>([])
const searched = ref(false)
const loading = ref(false)

let timer: ReturnType<typeof setTimeout>
watch(q, () => {
  clearTimeout(timer)
  if (q.value.trim().length < 2) { hits.value = []; searched.value = false; return }
  timer = setTimeout(async () => {
    loading.value = true
    try {
      hits.value = await api<Hit[]>('/knowledge/search', { query: { q: q.value } })
      searched.value = true
    }
    finally {
      loading.value = false
    }
  }, 300)
})
</script>

<template>
  <div>
    <h1>{{ t('kb.title') }}</h1>
    <input v-model="q" class="search" type="search" :placeholder="t('kb.searchHint')" autofocus>
    <p v-if="loading" class="sub">{{ t('common.loading') }}</p>
    <p v-else-if="searched && hits.length === 0" class="empty">{{ t('kb.nothing') }}</p>
    <div class="hits">
      <NuxtLink v-for="h in hits" :key="`${h.kind}:${h.id}`" :to="h.kind === 'article' ? `/learn/knowledge/${h.id}` : `/learn/knowledge/lesson/${h.id}`" class="hit">
        <span :class="['kind', h.kind]">{{ t(`kb.kind.${h.kind}`) }}</span>
        <span class="hit-title">{{ h.title }}</span>
        <!-- eslint-disable-next-line vue/no-v-html -- ts_headline из санитизированного plain_text, только <b> -->
        <span class="snippet" v-html="h.snippet" />
      </NuxtLink>
    </div>
  </div>
</template>

<style scoped>
h1 { margin: 0 0 var(--space-3); font-weight: 900; }
.search { width: 100%; box-sizing: border-box; font: inherit; font-size: var(--font-size-title-l); border: 2px solid var(--color-bg-line); border-radius: var(--radius-pill); padding: var(--space-3) var(--space-5); background: var(--color-bg-soft); color: var(--color-ink); margin-bottom: var(--space-4); }
.hits { display: grid; gap: var(--space-2); }
.hit { display: grid; gap: var(--space-1); background: var(--color-bg-soft); border-radius: var(--radius-m); padding: var(--space-3) var(--space-4); text-decoration: none; color: var(--color-ink); }
.kind { justify-self: start; font-size: var(--font-size-body-s); font-weight: 700; border-radius: var(--radius-pill); padding: 1px var(--space-2); background: var(--color-bg-line-soft); color: var(--color-ink-muted); }
.kind.lesson { background: var(--color-sun); color: var(--color-sun-ink); }
.hit-title { font-weight: 800; }
.snippet { font-size: var(--font-size-body-s); color: var(--color-ink-muted); }
.snippet :deep(b) { color: var(--color-ink); background: color-mix(in srgb, var(--color-sun) 40%, transparent); border-radius: 3px; padding: 0 2px; }
.sub, .empty { color: var(--color-ink-faint); text-align: center; padding: var(--space-4); }
</style>
