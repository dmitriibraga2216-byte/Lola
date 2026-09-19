<script setup lang="ts">
/**
 * Список тестов по мокапу ContentTests: чипы Автор · Мітки · Опубліковано, таблица
 * НАЗВА · ПИТАНЬ · АВТОР · МІТКИ · ДАТА ЗМІНИ · ОПУБЛІКОВАНО, «Додати».
 */
definePageMeta({ layout: 'admin', middleware: 'admin-scope', requiredScope: 'course.view' })

const { t, locale } = useI18n()
const { api } = useApi()
const { hasScope } = useAuth()

interface Quiz { id: string, title: string, kind: string, status: string, tags: string[], questionCount: number, totalPoints: string, updatedAt: string, authorName: string | null }

const items = ref<Quiz[]>([])
const newTitle = ref('')
const creating = ref(false)
const error = ref('')
const onlyPublished = ref(false)
const author = ref('')
const tag = ref('')

async function load() {
  try {
    items.value = await api<Quiz[]>('/quizzes')
  }
  catch (err) {
    error.value = apiErrorOf(err).message
  }
}
onMounted(load)

const authors = computed(() => [...new Set(items.value.map(q => q.authorName).filter((a): a is string => !!a))])
const tags = computed(() => [...new Set(items.value.flatMap(q => q.tags))])
const filtered = computed(() => items.value.filter(q =>
  (!onlyPublished.value || q.status === 'published')
  && (!author.value || q.authorName === author.value)
  && (!tag.value || q.tags.includes(tag.value)),
))

function fmtDate(iso: string) {
  return new Date(iso).toLocaleDateString(locale.value === 'uk' ? 'uk-UA' : 'en-GB', { day: '2-digit', month: '2-digit', year: 'numeric' })
}

async function create() {
  if (newTitle.value.trim().length < 3) return
  try {
    const q = await api<Quiz>('/quizzes', { method: 'POST', body: { title: newTitle.value.trim() } })
    await navigateTo(`/admin/quizzes/${q.id}`)
  }
  catch (err) {
    error.value = apiErrorOf(err).message
  }
}
</script>

<template>
  <div>
    <PageHeader :title="t('admin.nav.quizzes')" :crumbs="[{ label: t('admin.section.content') }, { label: t('admin.nav.quizzes') }]">
      <template #actions>
        <button v-if="hasScope('question.manage')" class="btn primary" @click="creating = !creating">{{ t('quizAdmin.add') }}</button>
      </template>
    </PageHeader>

    <form v-if="creating" class="card new" @submit.prevent="create">
      <label class="label" for="new-quiz-title">{{ t('quizAdmin.newTitle') }}</label>
      <div class="row">
        <input id="new-quiz-title" v-model="newTitle" class="field" :placeholder="t('quizAdmin.newTitle')">
        <button class="btn primary" type="submit" :disabled="newTitle.trim().length < 3">{{ t('course.create') }}</button>
      </div>
    </form>

    <div class="chips filters">
      <select v-model="author" class="field small" :aria-label="t('quizAdmin.colAuthor')">
        <option value="">{{ t('quizAdmin.colAuthor') }}</option>
        <option v-for="a in authors" :key="a" :value="a">{{ a }}</option>
      </select>
      <select v-model="tag" class="field small" :aria-label="t('quizAdmin.colTags')">
        <option value="">{{ t('quizAdmin.colTags') }}</option>
        <option v-for="tg in tags" :key="tg" :value="tg">{{ tg }}</option>
      </select>
      <button :class="['chip', { on: onlyPublished }]" :aria-pressed="onlyPublished" @click="onlyPublished = !onlyPublished">{{ t('quizAdmin.colPublished') }}</button>
    </div>

    <p v-if="error" class="error-text">{{ error }}</p>

    <div class="table-wrap">
      <table class="table">
        <thead>
          <tr>
            <th>{{ t('quizAdmin.colTitle') }}</th>
            <th class="num">{{ t('quizAdmin.colQuestions') }}</th>
            <th>{{ t('quizAdmin.colAuthor') }}</th>
            <th>{{ t('quizAdmin.colTags') }}</th>
            <th>{{ t('quizAdmin.colUpdated') }}</th>
            <th>{{ t('quizAdmin.colPublished') }}</th>
          </tr>
        </thead>
        <tbody>
          <tr v-for="q in filtered" :key="q.id">
            <td><NuxtLink :to="`/admin/quizzes/${q.id}`" class="link">{{ q.title }}</NuxtLink></td>
            <td class="num">{{ q.questionCount }}</td>
            <td>{{ q.authorName ?? '—' }}</td>
            <td><span v-for="tg in q.tags" :key="tg" class="badge muted">{{ tg }}</span></td>
            <td>{{ fmtDate(q.updatedAt) }}</td>
            <td><span :class="['badge', q.status]">{{ t(`course.status.${q.status}`) }}</span></td>
          </tr>
          <tr v-if="filtered.length === 0">
            <td colspan="6" class="muted">{{ t('quizAdmin.empty') }}</td>
          </tr>
        </tbody>
      </table>
    </div>
  </div>
</template>

<style scoped>
.new { margin-bottom: var(--space-4); }
.row { display: flex; gap: var(--space-2); flex-wrap: wrap; }
.row .field { flex: 1; min-width: 200px; }
.filters { margin-bottom: var(--space-3); }
.field.small { width: auto; }
.badge + .badge { margin-left: var(--space-1); }
</style>
