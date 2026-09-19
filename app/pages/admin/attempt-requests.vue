<script setup lang="ts">
/**
 * «Запити на спроби тестування» по мокапу AttemptRequests (docs/12 §14.5, §6.3):
 * таблица ТЕСТ · ЛЮДИНА · ВИКОРИСТАНО · ДАТА · СТАН, фильтр по умолчанию «Очікує»,
 * «Дати спробу» / «Відмовити» с комментарием.
 */
definePageMeta({ layout: 'admin', middleware: 'admin-scope', requiredScope: 'review.grade' })

const { t, locale } = useI18n()
const { api } = useApi()

interface Row {
  id: string
  quizTitle: string
  fullName: string
  positionName: string | null
  locationName: string | null
  reason: string
  attemptsUsed: number
  attemptsAllowed: number
  status: 'pending' | 'approved' | 'rejected'
  createdAt: string
  decisionComment: string | null
}

const TABS = ['pending', 'approved', 'rejected', 'all'] as const
const tab = ref<typeof TABS[number]>('pending')
const rows = ref<Row[]>([])
const comments = ref<Record<string, string>>({})
const error = ref('')
const notice = ref('')
const busy = ref('')

async function load() {
  try {
    rows.value = await api<Row[]>('/attempt-requests', { query: { status: tab.value } })
  }
  catch (err) {
    error.value = apiErrorOf(err).message
  }
}
onMounted(load)
watch(tab, load)

const fmtDate = (iso: string) => new Date(iso).toLocaleDateString(locale.value === 'uk' ? 'uk-UA' : 'en-GB', { day: '2-digit', month: '2-digit', year: 'numeric' })

async function decide(r: Row, approved: boolean) {
  busy.value = r.id
  error.value = ''
  try {
    await api(`/attempt-requests/${r.id}/decide`, { method: 'POST', body: { approved, comment: (comments.value[r.id] ?? '').trim() || undefined } })
    notice.value = approved ? t('attemptRequests.granted', { name: r.fullName }) : t('attemptRequests.declined', { name: r.fullName })
    await load()
  }
  catch (err) {
    error.value = apiErrorOf(err).message
  }
  finally {
    busy.value = ''
  }
}
</script>

<template>
  <div>
    <PageHeader :title="t('attemptRequests.title')" :crumbs="[{ label: t('admin.section.learning') }, { label: t('attemptRequests.title') }]" :subtitle="t('attemptRequests.hint')" />

    <div class="chips tabs" role="tablist">
      <button v-for="tb in TABS" :key="tb" role="tab" :aria-selected="tab === tb" :class="['chip', { on: tab === tb }]" @click="tab = tb">{{ t(`attemptRequests.tabs.${tb}`) }}</button>
    </div>

    <p v-if="error" class="error-text">{{ error }}</p>
    <p v-if="notice" class="note teal">{{ notice }}</p>

    <div class="table-wrap">
      <table class="table">
        <thead>
          <tr>
            <th>{{ t('attemptRequests.colQuiz') }}</th>
            <th>{{ t('attemptRequests.colPerson') }}</th>
            <th class="num">{{ t('attemptRequests.colUsed') }}</th>
            <th>{{ t('attemptRequests.colDate') }}</th>
            <th>{{ t('attemptRequests.colStatus') }}</th>
            <th />
          </tr>
        </thead>
        <tbody>
          <tr v-for="r in rows" :key="r.id">
            <td>
              <b>{{ r.quizTitle }}</b>
              <span class="sub">{{ r.reason }}</span>
            </td>
            <td>
              {{ r.fullName }}
              <span class="sub"><template v-if="r.positionName">{{ r.positionName }}</template><template v-if="r.locationName"> · {{ r.locationName }}</template></span>
            </td>
            <td class="num">{{ t('attemptRequests.used', { used: r.attemptsUsed, total: r.attemptsAllowed }) }}</td>
            <td>{{ fmtDate(r.createdAt) }}</td>
            <td>
              <span :class="['badge', r.status === 'pending' ? 'pending' : r.status === 'approved' ? 'passed' : 'failed']">{{ t(`attemptRequests.status.${r.status}`) }}</span>
              <span v-if="r.decisionComment" class="sub">{{ r.decisionComment }}</span>
            </td>
            <td>
              <div v-if="r.status === 'pending'" class="actions">
                <input v-model="comments[r.id]" class="field" :placeholder="t('attemptRequests.commentPh')" :aria-label="t('attemptRequests.commentPh')">
                <button class="btn primary small" :disabled="busy === r.id" @click="decide(r, true)">{{ t('attemptRequests.grant') }}</button>
                <button class="btn ghost small" :disabled="busy === r.id" @click="decide(r, false)">{{ t('attemptRequests.decline') }}</button>
              </div>
            </td>
          </tr>
          <tr v-if="rows.length === 0">
            <td colspan="6" class="muted">{{ t('attemptRequests.empty') }}</td>
          </tr>
        </tbody>
      </table>
    </div>
  </div>
</template>

<style scoped>
.tabs { margin-bottom: var(--space-4); }
.sub { display: block; font-size: var(--font-size-body-s); color: var(--color-ink-muted); }
.actions { display: flex; gap: var(--space-2); flex-wrap: wrap; align-items: center; min-width: 220px; }
.actions .field { flex: 1; min-width: 140px; }
</style>
