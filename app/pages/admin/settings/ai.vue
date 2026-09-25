<script setup lang="ts">
/**
 * «Налаштування → Штучний інтелект» (docs/v2/30-ai-interview.md §5.6, §7.13, §7.16; план `45` PR-29).
 *
 * Два блоки: перемикач функції «Підказка ШІ для перевіряючих» (вимкнена за замовчуванням —
 * вмикаючи її, простір вирішує надсилати відповіді співробітників моделі) і черга вибіркової
 * перевірки якості: висновок програми поруч із рішенням людини, вердикт — про програму, а не про
 * людину. Профілі провайдерів і журнал викликів мають API (PR-27), їхній екран — окремо.
 */
definePageMeta({ layout: 'admin', middleware: 'admin-scope', requiredScope: 'ai.audit' })

const { t } = useI18n()
const { api } = useApi()
const { formatDateTime } = useFormat()

interface Item {
  id: string
  refKind: 'interview_criterion_score' | 'review_hint' | 'summary'
  sampledBy: string
  sampleReason: string | null
  verdict: string | null
  notes: string | null
  reviewedAt: string | null
  createdAt: string
  subject: Record<string, unknown> | null
}

const VERDICTS = ['correct', 'minor_error', 'major_error', 'harmful'] as const
const FILTERS = ['pending', 'reviewed', 'all'] as const

const reviewHints = ref(false)
const items = ref<Item[]>([])
const cursor = ref<string | null>(null)
const status = ref<typeof FILTERS[number]>('pending')
const notes = ref<Record<string, string>>({})
const error = ref('')
const notice = ref('')
const busy = ref(false)

async function loadSettings() {
  try { reviewHints.value = (await api<{ reviewHints: boolean }>('/settings/ai')).reviewHints }
  catch (err) { error.value = apiErrorOf(err).message }
}

async function loadQueue(more = false) {
  error.value = ''
  try {
    const r = await api<{ items: Item[], nextCursor: string | null }>('/ai/quality-reviews', { query: { status: status.value, cursor: more ? cursor.value ?? undefined : undefined } })
    items.value = more ? [...items.value, ...r.items] : r.items
    cursor.value = r.nextCursor
  }
  catch (err) { error.value = apiErrorOf(err).message }
}

onMounted(async () => {
  await loadSettings()
  await loadQueue()
})
watch(status, () => loadQueue())

async function saveHints() {
  busy.value = true
  notice.value = ''
  try {
    reviewHints.value = (await api<{ reviewHints: boolean }>('/settings/ai', { method: 'PATCH', body: { reviewHints: reviewHints.value } })).reviewHints
    notice.value = t('aiSettings.saved')
  }
  catch (err) { error.value = apiErrorOf(err).message }
  finally { busy.value = false }
}

async function verdict(item: Item, v: typeof VERDICTS[number]) {
  busy.value = true
  try {
    const r = await api<Item>(`/ai/quality-reviews/${item.id}`, { method: 'POST', body: { verdict: v, notes: notes.value[item.id] || null } })
    items.value = items.value.map(i => (i.id === item.id ? r : i)).filter(i => status.value !== 'pending' || !i.verdict)
  }
  catch (err) { error.value = apiErrorOf(err).message }
  finally { busy.value = false }
}

const s = (item: Item) => (item.subject ?? {}) as Record<string, unknown>
const quoteOf = (item: Item) => ((s(item).evidence as { quote?: string }[] | undefined) ?? [])[0]?.quote ?? null
</script>

<template>
  <div>
    <PageHeader :title="t('aiSettings.title')" :subtitle="t('aiSettings.hint')" />

    <p v-if="error" class="error" role="alert">{{ error }}</p>
    <p v-if="notice" class="notice" role="status">{{ notice }}</p>

    <section class="panel form">
      <label class="row">
        <input v-model="reviewHints" type="checkbox" @change="saveHints">
        <span>{{ t('aiSettings.reviewHints') }}</span>
      </label>
      <p class="sub">{{ t('aiSettings.reviewHintsHint') }}</p>
    </section>

    <section class="panel">
      <h2 class="h2">{{ t('aiSettings.quality') }}</h2>
      <p class="sub">{{ t('aiSettings.qualityHint') }}</p>
      <div class="chips" role="tablist">
        <button v-for="f in FILTERS" :key="f" role="tab" :aria-selected="status === f" :class="['chip', { on: status === f }]" @click="status = f">{{ t(`aiSettings.filter.${f}`) }}</button>
      </div>
      <p v-if="!items.length" class="muted">{{ t('aiSettings.empty') }}</p>
      <article v-for="item in items" :key="item.id" class="card item">
        <header class="row between">
          <b>{{ t(`aiSettings.ref.${item.refKind}`) }}</b>
          <span class="sub">{{ item.sampleReason ? t(`aiSettings.reason.${item.sampleReason}`) : '' }} · {{ formatDateTime(item.createdAt) }}</span>
        </header>
        <template v-if="item.refKind === 'interview_criterion_score'">
          <p><b>{{ s(item).criterion }}</b> — {{ t('aiSettings.model', { value: `${s(item).value ?? '—'} / ${s(item).scaleMax ?? '—'}`, human: s(item).humanValue ?? '—' }) }}</p>
          <p v-if="s(item).redacted" class="sub">{{ t('aiSettings.redacted') }}</p>
          <p v-else-if="s(item).rationale" class="sub">{{ t('aiSettings.rationale') }}: {{ s(item).rationale }}</p>
          <p v-if="quoteOf(item)" class="quote">«{{ quoteOf(item) }}»</p>
        </template>
        <template v-else-if="item.refKind === 'review_hint'">
          <p>{{ t('aiSettings.coverage', { value: s(item).coverage ?? '—' }) }}</p>
        </template>
        <div v-if="!item.verdict" class="row">
          <input v-model="notes[item.id]" class="field grow" :placeholder="t('aiSettings.notes')" :aria-label="t('aiSettings.notes')">
          <button v-for="v in VERDICTS" :key="v" class="btn ghost small" type="button" :disabled="busy" @click="verdict(item, v)">{{ t(`aiSettings.verdict.${v}`) }}</button>
        </div>
        <p v-else class="note teal">{{ t(`aiSettings.verdict.${item.verdict}`) }}<template v-if="item.notes"> · {{ item.notes }}</template></p>
      </article>
      <button v-if="cursor" class="btn ghost small" type="button" @click="loadQueue(true)">{{ t('aiSettings.more') }}</button>
    </section>
  </div>
</template>

<style scoped>
.form { display: grid; gap: var(--space-2); max-width: 40rem; margin-bottom: var(--space-4); }
.row { display: flex; gap: var(--space-2); align-items: center; flex-wrap: wrap; }
.between { justify-content: space-between; }
.grow { flex: 1; min-width: 10rem; }
.h2 { margin: 0 0 var(--space-1); font-size: var(--font-size-body); font-weight: 900; }
.sub { margin: 0; color: var(--color-ink-muted); font-size: var(--font-size-body-s); }
.chips { margin: var(--space-3) 0; }
.item { display: grid; gap: var(--space-2); margin-bottom: var(--space-3); }
.item p { margin: 0; }
.quote { font-style: italic; }
</style>
