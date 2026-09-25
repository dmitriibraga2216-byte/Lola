<script setup lang="ts">
/**
 * «Підсумок кандидата» за посиланням з листа — без входу (docs/v2/30-ai-interview.md §5.4, §7.14,
 * §8 `interview.result_ready`, §10 `GET /public/candidate-summaries/:token`).
 *
 * Кандидат приходить з телефона (сквозна перевірка 24 `docs/v2/42` §5): одна колонка, 320 px, без
 * горизонтального скролу. Мова — мова документа (мова кандидата), а не браузера. Документ — лише
 * розділи, які рекрутер лишив увімкненими, без ПД третіх осіб; рядок «Документ сформовано
 * автоматично…» — завжди, з тексту документа. Минулий строк і відкликаний доступ — окремими
 * зрозумілими рядками, а не «помилкою».
 */
definePageMeta({ layout: false })

const { t, setLocale } = useI18n()
const { api } = useApi()
const route = useRoute()
const { formatDate } = useFormat()

interface PublicSummary {
  version: number
  completeness: 'full' | 'partial'
  lang: 'uk' | 'en' | 'ru'
  sentAt: string
  expiresAt: string
  document: Record<string, unknown>
  disclaimerLine: string
}

const summary = ref<PublicSummary | null>(null)
const failure = ref<'notFound' | 'expired' | 'revoked' | 'tooMany' | null>(null)
const loading = ref(true)

onMounted(async () => {
  try {
    const data = await api<PublicSummary>(`/public/candidate-summaries/${route.params.token}`)
    summary.value = data
    setLocale(data.lang)
  }
  catch (err) {
    const code = apiErrorOf(err).code
    failure.value = code === 'summary.share_expired' ? 'expired' : code === 'summary.revoked' ? 'revoked' : code === 'rate.too_many' ? 'tooMany' : 'notFound'
  }
  finally {
    loading.value = false
  }
})
</script>

<template>
  <main class="wrap">
    <header class="head">
      <span class="logo">Lola</span>
      <span class="sub">{{ t('candidateSummary.title') }}</span>
    </header>

    <p v-if="loading" class="sub" role="status">{{ t('candidateSummary.public.loading') }}</p>
    <p v-else-if="failure" class="card center" role="alert">{{ t(`candidateSummary.public.${failure}`) }}</p>

    <template v-else-if="summary">
      <h1>{{ t('candidateSummary.title') }}</h1>
      <p class="meta">
        <span v-if="summary.completeness === 'partial'" class="chip">{{ t('candidateSummary.partial') }}</span>
        <span class="sub">{{ t('candidateSummary.version', { n: summary.version }) }} · {{ formatDate(summary.sentAt) }}</span>
      </p>
      <section class="card">
        <SummaryDocument :doc="summary.document" :disclaimer-line="summary.disclaimerLine" />
      </section>
      <p class="sub">{{ t('candidateSummary.public.validUntil', { date: formatDate(summary.expiresAt) }) }}</p>
    </template>
  </main>
</template>

<style scoped>
.wrap { max-width: 640px; margin: 0 auto; padding: var(--space-4) var(--space-4) var(--space-7); overflow-wrap: anywhere; }
.head { display: flex; align-items: baseline; gap: var(--space-2); margin-bottom: var(--space-3); flex-wrap: wrap; }
.logo { font-weight: 900; font-size: var(--font-size-title-l); }
h1 { margin: 0 0 var(--space-2); font-weight: 900; font-size: var(--font-size-title-l); }
.meta { display: flex; flex-wrap: wrap; gap: var(--space-2); align-items: center; margin: 0 0 var(--space-3); }
.chip { background: var(--color-sun-soft); border-radius: var(--radius-pill); padding: var(--space-1) var(--space-3); font-size: var(--font-size-body-s); font-weight: 700; }
.sub { color: var(--color-ink-muted); font-size: var(--font-size-body-s); margin: 0; }
.card { background: var(--color-bg-soft); border-radius: var(--radius-l); padding: var(--space-3); margin: 0 0 var(--space-3); }
.center { text-align: center; padding: var(--space-7) var(--space-4); }
</style>
