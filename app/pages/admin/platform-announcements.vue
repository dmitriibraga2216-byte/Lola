<script setup lang="ts">
/**
 * Объявления платформы (docs/v2/39 П-21, П-24.2; docs/24 §4.7) — лента **от Lola**, только для
 * чтения: пишет оператор платформы, пространство не создаёт и не правит их. Это не «Новини»
 * компании (`/admin/news`): там пишет администратор пространства для своих сотрудников.
 */
definePageMeta({ layout: 'admin', middleware: 'admin-scope', requiredScope: 'learn.view' })
const { t } = useI18n()
const { api } = useApi()
const { formatDate } = useFormat()

interface Item { id: string, title: string, body: string, publishedAt: string, read: boolean }
const items = ref<Item[]>([])
const unread = ref(0)
const loaded = ref(false)
const error = ref('')

async function load() {
  error.value = ''
  try {
    const r = await api<{ items: Item[], unread: number }>('/platform-announcements')
    items.value = r.items
    unread.value = r.unread
  }
  catch (err) { error.value = apiErrorOf(err).message }
  finally { loaded.value = true }
}
onMounted(load)

async function markRead(item: Item) {
  try {
    await api(`/platform-announcements/${item.id}/read`, { method: 'POST' })
    item.read = true
    unread.value = Math.max(0, unread.value - 1)
  }
  catch (err) { error.value = apiErrorOf(err).message }
}
</script>

<template>
  <div>
    <PageHeader :title="t('platformNews.title')" :crumbs="[{ label: t('admin.section.settings') }, { label: t('platformNews.title') }]" />
    <p class="help">{{ t('platformNews.hint') }}</p>
    <p v-if="error" class="error-text" role="alert">{{ error }}</p>
    <p v-if="loaded && unread" class="note sun" role="status">{{ t('platformNews.unread', { n: unread }) }}</p>
    <p v-if="loaded && !items.length" class="faint">{{ t('platformNews.empty') }}</p>
    <article v-for="a in items" :key="a.id" class="card item" :class="{ unread: !a.read }" data-testid="platform-announcement">
      <header class="head">
        <h2 class="title">{{ a.title }}</h2>
        <span class="sub">{{ formatDate(a.publishedAt) }}</span>
      </header>
      <p class="body">{{ a.body }}</p>
      <button v-if="!a.read" class="btn ghost small" type="button" @click="markRead(a)">{{ t('platformNews.markRead') }}</button>
      <span v-else class="badge muted">{{ t('platformNews.read') }}</span>
    </article>
  </div>
</template>

<style scoped>
.item { display: grid; gap: var(--space-2); margin-bottom: var(--space-3); justify-items: start; }
.item.unread { border-left: 4px solid var(--color-sun); }
.head { display: flex; gap: var(--space-3); align-items: baseline; flex-wrap: wrap; }
.title { margin: 0; font-size: var(--font-size-title-l); font-weight: 800; }
.sub { color: var(--color-ink-muted); font-size: var(--font-size-body-s); }
.body { margin: 0; white-space: pre-line; }
</style>
