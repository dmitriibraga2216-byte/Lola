<script setup lang="ts">
/**
 * «Сценарії співбесід» — `/admin/settings/interviews` (docs/v2/30-ai-interview.md §5.6, §6.1).
 *
 * Список: назва, модуль, версія, критеріїв, проведено співбесід, частка `needs_human` — сигнал,
 * що сценарій чи провайдер погані. Новий сценарій — лише для тесту виду «Співбесіда» (docs/v2/44
 * В-12); опублікувати його без альтернативи для тих, хто відмовиться від ШІ, сервер не дасть.
 */
definePageMeta({ layout: 'admin', middleware: 'admin-scope', requiredScope: 'interview.configure' })

const { t } = useI18n()
const { api } = useApi()
const { formatShortDate } = useFormat()

interface Row {
  id: string
  quizTitle: string | null
  name: string
  status: 'draft' | 'published' | 'archived'
  version: number
  criteriaCount: number
  sessionsCount: number
  needsHumanShare: number | null
  updatedAt: string
}
interface QuizRow { id: string, title: string, kind: string }

const rows = ref<Row[]>([])
const cursor = ref<string | null>(null)
const loading = ref(false)
const error = ref('')
const creating = ref(false)
const quizzes = ref<QuizRow[]>([])
const form = reactive({ quizId: '', name: '' })

async function load(more = false) {
  loading.value = true
  error.value = ''
  try {
    const r = await api<{ items: Row[], nextCursor: string | null }>('/interview-scenarios', { query: more && cursor.value ? { cursor: cursor.value } : {} })
    rows.value = more ? [...rows.value, ...r.items] : r.items
    cursor.value = r.nextCursor
  }
  catch (err) { error.value = apiErrorOf(err).message }
  finally { loading.value = false }
}
onMounted(() => load())

async function openCreate() {
  creating.value = true
  try { quizzes.value = (await api<QuizRow[]>('/quizzes')).filter(q => q.kind === 'interview') }
  catch { quizzes.value = [] }
}

async function create() {
  error.value = ''
  try {
    const s = await api<{ id: string }>('/interview-scenarios', {
      method: 'POST',
      body: {
        quizId: form.quizId,
        name: form.name.trim(),
        introText: t('interviewAdmin.defaultIntro'),
        outroText: t('interviewAdmin.defaultOutro'),
      },
    })
    await navigateTo(`/admin/settings/interviews/${s.id}`)
  }
  catch (err) { error.value = apiErrorOf(err).message }
}

const share = (v: number | null) => (v === null ? '—' : `${Math.round(v * 100)} %`)
</script>

<template>
  <div>
    <PageHeader :title="t('interviewAdmin.title')" :subtitle="t('interviewAdmin.subtitle')" :crumbs="[{ label: t('admin.section.people') }, { label: t('interviewAdmin.title') }]">
      <template #actions>
        <button class="btn primary" type="button" @click="openCreate">{{ t('interviewAdmin.new') }}</button>
      </template>
    </PageHeader>

    <p v-if="error" class="note coral" role="alert">{{ error }}</p>

    <form v-if="creating" class="card new" @submit.prevent="create">
      <label class="stack">
        <span class="label">{{ t('interviewAdmin.quiz') }}</span>
        <select v-model="form.quizId" class="field" required>
          <option value="" disabled>{{ t('interviewAdmin.quizPick') }}</option>
          <option v-for="q in quizzes" :key="q.id" :value="q.id">{{ q.title }}</option>
        </select>
        <span v-if="!quizzes.length" class="help">{{ t('interviewAdmin.noInterviewQuizzes') }}</span>
      </label>
      <label class="stack">
        <span class="label">{{ t('interviewAdmin.name') }}</span>
        <input v-model="form.name" class="field" minlength="3" maxlength="200" required>
      </label>
      <div class="actions">
        <button class="btn primary" type="submit" :disabled="!form.quizId || form.name.trim().length < 3">{{ t('interviewAdmin.create') }}</button>
        <button class="btn ghost" type="button" @click="creating = false">{{ t('common.cancel') }}</button>
      </div>
    </form>

    <div class="table-wrap">
      <table class="table">
        <thead>
          <tr>
            <th>{{ t('interviewAdmin.col.name') }}</th>
            <th>{{ t('interviewAdmin.col.quiz') }}</th>
            <th class="num">{{ t('interviewAdmin.col.criteria') }}</th>
            <th class="num">{{ t('interviewAdmin.col.sessions') }}</th>
            <th class="num">{{ t('interviewAdmin.col.needsHuman') }}</th>
            <th>{{ t('interviewAdmin.col.status') }}</th>
            <th>{{ t('interviewAdmin.col.updated') }}</th>
          </tr>
        </thead>
        <tbody>
          <tr v-for="r in rows" :key="r.id">
            <td>
              <NuxtLink :to="`/admin/settings/interviews/${r.id}`" class="link">{{ r.name }}</NuxtLink>
              <span class="sub">{{ t('interviewAdmin.version', { n: r.version }) }}</span>
            </td>
            <td>{{ r.quizTitle ?? '—' }}</td>
            <td class="num">{{ r.criteriaCount }}</td>
            <td class="num">{{ r.sessionsCount }}</td>
            <td class="num">{{ share(r.needsHumanShare) }}</td>
            <td><span :class="['badge', r.status === 'published' ? 'teal' : 'muted']">{{ t(`interviewAdmin.status.${r.status}`) }}</span></td>
            <td>{{ formatShortDate(r.updatedAt) }}</td>
          </tr>
          <tr v-if="!rows.length && !loading">
            <td colspan="7" class="muted">{{ t('interviewAdmin.empty') }}</td>
          </tr>
        </tbody>
      </table>
    </div>
    <LoadMore v-if="cursor" :loading="loading" @more="load(true)" />
  </div>
</template>

<style scoped>
.new { display: grid; gap: var(--space-3); max-width: 36rem; margin-bottom: var(--space-4); }
.stack { display: grid; gap: var(--space-1); }
.actions { display: flex; flex-wrap: wrap; gap: var(--space-2); }
</style>
