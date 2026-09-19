<script setup lang="ts">
definePageMeta({ layout: 'admin', middleware: 'admin-scope', requiredScope: 'knowledge.manage' })
const { t } = useI18n()
const { api } = useApi()
interface A { id: string, title: string, status: string, tags: string[], version: number, viewCount: number, updatedAt: string }
const items = ref<A[]>([])
const title = ref('')
const error = ref('')
async function load() { try { items.value = await api<A[]>('/knowledge') } catch (err) { error.value = apiErrorOf(err).message } }
onMounted(load)
async function create() {
  if (title.value.trim().length < 3) return
  try {
    const a = await api<{ id: string }>('/knowledge', { method: 'POST', body: { title: title.value.trim(), body: [{ id: 'b1', type: 'text', html: '<p></p>' }] } })
    await navigateTo(`/admin/knowledge/${a.id}`)
  } catch (err) { error.value = apiErrorOf(err).message }
}
</script>
<template>
  <div>
    <header class="head">
      <h1>{{ t('admin.nav.knowledge') }}</h1>
      <div class="new"><input v-model="title" :placeholder="t('kb.newTitle')" @keyup.enter="create"><button class="primary" :disabled="title.trim().length < 3" @click="create">{{ t('course.create') }}</button></div>
    </header>
    <p v-if="error" class="error">{{ error }}</p>
    <ul class="list">
      <li v-for="a in items" :key="a.id"><NuxtLink :to="`/admin/knowledge/${a.id}`" class="row">
        <span class="title">{{ a.title }}</span><span class="sub">v{{ a.version }} · {{ a.viewCount }} {{ t('kb.views') }}</span>
        <span :class="['badge', a.status]">{{ t(`course.status.${a.status}`) }}</span>
      </NuxtLink></li>
      <li v-if="items.length === 0" class="empty">{{ t('kb.empty') }}</li>
    </ul>
  </div>
</template>
<style scoped>
.head { display: flex; align-items: center; gap: var(--space-4); flex-wrap: wrap; margin-bottom: var(--space-4); }
h1 { margin: 0; font-weight: 900; }
.new { margin-left: auto; display: flex; gap: var(--space-2); }
input { font: inherit; border: 1px solid var(--color-bg-line); border-radius: var(--radius-pill); padding: var(--space-2) var(--space-4); background: var(--color-bg-soft); color: var(--color-ink); min-width: 240px; }
.primary { font: inherit; font-weight: 800; border: none; background: var(--color-sun); color: var(--color-ink); border-radius: var(--radius-pill); padding: var(--space-2) var(--space-4); cursor: pointer; }
.primary:disabled { opacity: 0.5; }
.list { list-style: none; margin: 0; padding: 0; display: grid; gap: var(--space-2); }
.row { display: flex; align-items: center; gap: var(--space-3); background: var(--color-bg-soft); border-radius: var(--radius-m); padding: var(--space-3) var(--space-4); text-decoration: none; color: var(--color-ink); }
.title { flex: 1; font-weight: 700; }
.badge { font-size: var(--font-size-body-s); font-weight: 700; border-radius: var(--radius-pill); padding: 2px var(--space-3); background: var(--color-bg-line-soft); }
.badge.published { background: var(--color-teal); color: var(--color-teal-deep); }
.badge.draft { background: var(--color-sun); color: var(--color-sun-ink); }
.sub { font-size: var(--font-size-body-s); color: var(--color-ink-faint); }
.empty { color: var(--color-ink-faint); padding: var(--space-6); text-align: center; }
.error { color: var(--color-coral-ink); }
</style>
