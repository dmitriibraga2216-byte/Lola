<script setup lang="ts">
/**
 * «Мої повідомлення про помилки» (docs/v2/36-content-feedback.md §5.5): вкладка профілю —
 * тип, елемент, дата, статус простими словами і відповідь автора. Статус рахує сервер
 * (`reporterStatus`), тут лише підпис. Телефон — перш за все.
 */
definePageMeta({ layout: 'learner' })
const { t } = useI18n()
const { api } = useApi()
const { formatShortDate } = useFormat()

interface Report {
  reportId: string
  createdAt: string
  issueType: string
  targetType: string
  title: string
  reporterStatus: 'reviewing' | 'fixed' | 'not_confirmed'
  resolutionComment: string | null
}

const items = ref<Report[] | null>(null)
const error = ref(false)

async function load() {
  error.value = false
  try { items.value = await api<Report[]>('/me/content-reports') }
  catch { error.value = true }
}
onMounted(load)
</script>

<template>
  <div>
    <div class="head">
      <NuxtLink to="/learn/profile" class="back" :aria-label="t('common.back')">
        <svg viewBox="0 0 24 24" aria-hidden="true"><path d="M19 12H6" stroke="currentColor" stroke-width="2" fill="none" stroke-linecap="round" /><path d="M11 18l-6-6 6-6" stroke="currentColor" stroke-width="2" fill="none" stroke-linecap="round" stroke-linejoin="round" /></svg>
      </NuxtLink>
      <h1>{{ t('issue.mine.title') }}</h1>
    </div>

    <div v-if="error" class="error" role="alert">
      <span>{{ t('issue.mine.loadError') }}</span>
      <button type="button" class="retry" @click="load">{{ t('issue.mine.retry') }}</button>
    </div>
    <p v-else-if="!items" class="empty" aria-busy="true">{{ t('issue.mine.loading') }}</p>
    <p v-else-if="items.length === 0" class="empty">{{ t('issue.mine.empty') }}</p>
    <ul v-else class="list">
      <li v-for="it in items" :key="it.reportId" class="row">
        <div class="row-top">
          <span class="type">{{ t(`issue.type.${it.issueType}`) }}</span>
          <span :class="['status', it.reporterStatus]">{{ t(`issue.mine.status.${it.reporterStatus}`) }}</span>
        </div>
        <span class="title">{{ it.title }}</span>
        <span class="sub">{{ t(`contentIssues.target.${it.targetType}`) }} · {{ formatShortDate(new Date(it.createdAt)) }}</span>
        <p v-if="it.resolutionComment && it.reporterStatus !== 'reviewing'" class="answer">
          <b>{{ t('issue.mine.answer') }}:</b> {{ it.resolutionComment }}
        </p>
      </li>
    </ul>
  </div>
</template>

<style scoped>
.head { display: flex; align-items: center; gap: var(--space-3); margin-bottom: var(--space-3); }
.back { border: none; background: none; padding: 0; cursor: pointer; color: var(--color-ink); display: flex; }
.back svg { width: var(--space-5); height: var(--space-5); }
h1 { margin: 0; font-weight: 900; font-size: var(--font-size-title-l); }
.list { display: grid; gap: var(--space-2); list-style: none; margin: 0; padding: 0; }
.row { display: grid; gap: var(--space-1); background: var(--color-bg-soft); border-radius: var(--radius-m); padding: var(--space-3); min-width: 0; }
.row-top { display: flex; justify-content: space-between; align-items: center; gap: var(--space-2); flex-wrap: wrap; }
.type { font-size: var(--font-size-body-s); font-weight: 700; color: var(--color-ink-muted); }
.title { font-weight: 800; overflow-wrap: anywhere; }
.sub { font-size: var(--font-size-body-s); color: var(--color-ink-muted); }
.status { font-size: var(--font-size-body-s); font-weight: 800; border-radius: var(--radius-pill); padding: 0 var(--space-2); white-space: nowrap; }
.status.reviewing { background: var(--color-sun); color: var(--color-ink); }
.status.fixed { background: var(--color-teal); color: var(--color-teal-deep); }
.status.not_confirmed { background: var(--color-coral); color: var(--color-coral-deep); }
.answer { margin: var(--space-1) 0 0; font-size: var(--font-size-body-s); overflow-wrap: anywhere; }
.empty { color: var(--color-ink-muted); padding: var(--space-3); }
.error { display: flex; flex-wrap: wrap; align-items: center; gap: var(--space-2); background: var(--color-coral); color: var(--color-coral-deep); border-radius: var(--radius-m); padding: var(--space-3); }
.retry { border: none; background: var(--color-sun); color: var(--color-ink); font-weight: 800; border-radius: var(--radius-pill); padding: var(--space-1) var(--space-3); cursor: pointer; }
</style>
