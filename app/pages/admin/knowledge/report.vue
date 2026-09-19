<script setup lang="ts">
definePageMeta({ layout: 'admin', middleware: 'admin-scope', requiredScope: 'knowledge.manage' })
const { t } = useI18n()
const { api } = useApi()
interface Rep { top: Record<string, unknown>[], poor: Record<string, unknown>[], overdue: Record<string, unknown>[], emptyQueries: { query: string, times: number, last_at: string }[] }
const rep = ref<Rep | null>(null)
const error = ref('')
onMounted(async () => { try { rep.value = await api('/reports/knowledge') } catch (err) { error.value = apiErrorOf(err).message } })
</script>
<template>
  <div>
    <h1>{{ t('kb.report') }}</h1>
    <p v-if="error" class="error" role="alert">{{ error }}</p>
    <div v-if="rep" class="grid">
      <section class="card"><h2>{{ t('kb.mostRead') }}</h2><ul class="list"><li v-for="a in rep.top" :key="String(a.id)"><NuxtLink :to="`/admin/knowledge/${a.id}`" class="link">{{ a.title }}</NuxtLink> <span class="sub">{{ a.view_count }} · 👍{{ a.helpful_count }} 👎{{ a.not_helpful_count }}</span></li><li v-if="!rep.top.length" class="sub">{{ t('person.noData') }}</li></ul></section>
      <section class="card"><h2>{{ t('kb.poorFeedback') }}</h2><ul class="list"><li v-for="a in rep.poor" :key="String(a.id)"><NuxtLink :to="`/admin/knowledge/${a.id}`" class="link">{{ a.title }}</NuxtLink> <span class="sub">👍{{ a.helpful_count }} 👎{{ a.not_helpful_count }}</span></li><li v-if="!rep.poor.length" class="sub">{{ t('person.noData') }}</li></ul></section>
      <section class="card"><h2>{{ t('kb.overdueReview') }}</h2><ul class="list"><li v-for="a in rep.overdue" :key="String(a.id)"><NuxtLink :to="`/admin/knowledge/${a.id}`" class="link">{{ a.title }}</NuxtLink> <span class="sub">{{ a.review_at }} · {{ a.owner ?? '—' }}</span></li><li v-if="!rep.overdue.length" class="sub">{{ t('person.noData') }}</li></ul></section>
      <section class="card"><h2>{{ t('kb.emptyQueries') }}</h2><p class="sub">{{ t('kb.emptyQueriesHint') }}</p><ul class="list"><li v-for="q in rep.emptyQueries" :key="q.query"><b>{{ q.query }}</b> <span class="sub">× {{ q.times }}</span></li><li v-if="!rep.emptyQueries.length" class="sub">{{ t('person.noData') }}</li></ul></section>
    </div>
  </div>
</template>
<style scoped>
h1 { margin: 0 0 var(--space-3); font-weight: 900; }
h2 { margin: 0 0 var(--space-2); font-size: var(--font-size-body); font-weight: 800; }
.grid { display: grid; grid-template-columns: repeat(auto-fit, minmax(280px, 1fr)); gap: var(--space-3); }
.card { background: var(--color-bg-soft); border-radius: var(--radius-m); padding: var(--space-3); }
.list { list-style: none; margin: 0; padding: 0; display: grid; gap: var(--space-1); }
.link { color: var(--color-ink); font-weight: 700; text-decoration: none; }
.sub { font-size: var(--font-size-body-s); color: var(--color-ink-faint); }
.error { color: var(--color-coral-ink); }
</style>
