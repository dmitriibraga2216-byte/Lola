<script setup lang="ts">
definePageMeta({ layout: 'admin', middleware: 'admin-scope', requiredScope: 'course.view' })

const { t } = useI18n()
const { api } = useApi()
const { hasScope } = useAuth()

interface Quiz { id: string, title: string, kind: string, status: string, questionCount: number, totalPoints: string }

const items = ref<Quiz[]>([])
const newTitle = ref('')
const error = ref('')

async function load() {
  try {
    items.value = await api<Quiz[]>('/quizzes')
  }
  catch (err) {
    error.value = apiErrorOf(err).message
  }
}
onMounted(load)

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
    <header class="head">
      <h1>{{ t('admin.nav.quizzes') }}</h1>
      <div v-if="hasScope('question.manage')" class="new">
        <input v-model="newTitle" :placeholder="t('quizAdmin.newTitle')" @keyup.enter="create">
        <button class="primary" :disabled="newTitle.trim().length < 3" @click="create">{{ t('course.create') }}</button>
      </div>
    </header>
    <p v-if="error" class="error">{{ error }}</p>
    <ul class="list">
      <li v-for="q in items" :key="q.id">
        <NuxtLink :to="`/admin/quizzes/${q.id}`" class="row">
          <span class="title">{{ q.title }}</span>
          <span class="sub">{{ t('quizAdmin.countShort', { n: q.questionCount }) }} · {{ q.totalPoints }} {{ t('quizAdmin.pts') }}</span>
          <span :class="['badge', q.status]">{{ t(`course.status.${q.status}`) }}</span>
        </NuxtLink>
      </li>
      <li v-if="items.length === 0" class="empty">{{ t('quizAdmin.empty') }}</li>
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
.sub { font-size: var(--font-size-body-s); color: var(--color-ink-faint); }
.badge { font-size: var(--font-size-body-s); font-weight: 700; border-radius: var(--radius-pill); padding: 2px var(--space-3); background: var(--color-bg-line-soft); }
.badge.published { background: var(--color-teal); color: var(--color-teal-deep); }
.badge.draft { background: var(--color-sun); color: var(--color-sun-ink); }
.empty { color: var(--color-ink-faint); padding: var(--space-6); text-align: center; }
.error { color: var(--color-coral-ink); }
</style>
