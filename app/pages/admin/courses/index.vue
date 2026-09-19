<script setup lang="ts">
definePageMeta({ layout: 'admin', middleware: 'admin-scope', requiredScope: 'course.view' })

const { t } = useI18n()
const { api } = useApi()
const { hasScope } = useAuth()

interface Course {
  id: string
  title: string
  status: string
  isCatalogVisible: boolean
  updatedAt: string
}

const items = ref<Course[]>([])
const error = ref('')
const newTitle = ref('')
const busy = ref(false)

async function load() {
  try {
    items.value = await api<Course[]>('/courses')
  }
  catch (err) {
    error.value = apiErrorOf(err).message
  }
}
onMounted(load)

async function create() {
  if (newTitle.value.trim().length < 3) return
  busy.value = true
  error.value = ''
  try {
    const course = await api<Course>('/courses', { method: 'POST', body: { title: newTitle.value.trim() } })
    await navigateTo(`/admin/courses/${course.id}`)
  }
  catch (err) {
    error.value = apiErrorOf(err).message
  }
  finally {
    busy.value = false
  }
}
</script>

<template>
  <div>
    <header class="head">
      <h1>{{ t('admin.nav.courses') }}</h1>
      <div v-if="hasScope('course.create')" class="new">
        <input v-model="newTitle" :placeholder="t('course.newTitle')" @keyup.enter="create">
        <button class="primary" :disabled="busy || newTitle.trim().length < 3" @click="create">
          {{ t('course.create') }}
        </button>
      </div>
    </header>

    <p v-if="error" class="error">{{ error }}</p>

    <ul class="list">
      <li v-for="course in items" :key="course.id">
        <NuxtLink :to="`/admin/courses/${course.id}`" class="row">
          <span class="title">{{ course.title }}</span>
          <span :class="['badge', course.status]">{{ t(`course.status.${course.status}`) }}</span>
          <span v-if="course.isCatalogVisible" class="sub">{{ t('course.inCatalog') }}</span>
        </NuxtLink>
      </li>
      <li v-if="items.length === 0" class="empty">{{ t('course.empty') }}</li>
    </ul>
  </div>
</template>

<style scoped>
.head {
  display: flex;
  align-items: center;
  gap: var(--space-4);
  flex-wrap: wrap;
  margin-bottom: var(--space-4);
}

h1 {
  margin: 0;
  font-weight: 900;
}

.new {
  margin-left: auto;
  display: flex;
  gap: var(--space-2);
  flex-wrap: wrap;
}

input {
  font: inherit;
  border: 1px solid var(--color-bg-line);
  border-radius: var(--radius-pill);
  padding: var(--space-2) var(--space-4);
  background: var(--color-bg-soft);
  color: var(--color-ink);
  min-width: 0;
  flex: 1 1 200px;
}

.primary {
  font: inherit;
  font-weight: 800;
  border: none;
  background: var(--color-sun);
  color: var(--color-ink);
  border-radius: var(--radius-pill);
  padding: var(--space-2) var(--space-4);
  cursor: pointer;
}

.primary:disabled {
  opacity: 0.5;
}

.list {
  list-style: none;
  margin: 0;
  padding: 0;
  display: grid;
  gap: var(--space-2);
}

.row {
  display: flex;
  align-items: center;
  gap: var(--space-3);
  background: var(--color-bg-soft);
  border-radius: var(--radius-m);
  padding: var(--space-3) var(--space-4);
  text-decoration: none;
  color: var(--color-ink);
}

.title {
  flex: 1;
  font-weight: 700;
}

.badge {
  font-size: var(--font-size-body-s);
  font-weight: 700;
  border-radius: var(--radius-pill);
  padding: 2px var(--space-3);
  background: var(--color-bg-line-soft);
}

.badge.published {
  background: var(--color-teal);
  color: var(--color-teal-deep);
}

.badge.draft {
  background: var(--color-sun);
  color: var(--color-sun-ink);
}

.sub {
  font-size: var(--font-size-body-s);
  color: var(--color-ink-faint);
}

.empty {
  color: var(--color-ink-faint);
  padding: var(--space-6);
  text-align: center;
}

.error {
  color: var(--color-coral-ink);
}
</style>
