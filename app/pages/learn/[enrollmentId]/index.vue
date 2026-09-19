<script setup lang="ts">
definePageMeta({ layout: 'learner' })

const { t } = useI18n()
const { api } = useApi()
const route = useRoute()
const enrollmentId = route.params.enrollmentId as string

interface Tree {
  enrollment: { status: string, progressPct: string, requiredTotal: number, requiredDone: number }
  course: { id: string, title: string, strictOrder: boolean }
  modules: { id: string, title: string, lessons: { id: string, title: string, itemType: string, isRequired: boolean, status: string }[] }[]
  resumeLessonId: string | null
}

const tree = ref<Tree | null>(null)
const error = ref('')

onMounted(async () => {
  try {
    tree.value = await api<Tree>(`/learning/enrollments/${enrollmentId}`)
  }
  catch (err) {
    error.value = apiErrorOf(err).message
  }
})

function icon(status: string, itemType: string) {
  return status === 'completed' ? '✓' : status === 'locked' ? '🔒' : itemType === 'quiz' ? '?' : itemType === 'workshop' ? '✎' : '›'
}
</script>

<template>
  <div v-if="tree">
    <NuxtLink to="/learn" class="back">← {{ t('learner.nav.learning') }}</NuxtLink>
    <h1>{{ tree.course.title }}</h1>
    <div class="progress">
      <div class="bar" :style="{ width: `${tree.enrollment.progressPct}%` }" />
    </div>
    <p class="meta">
      {{ t('learner.progressOf', { done: tree.enrollment.requiredDone, total: tree.enrollment.requiredTotal }) }}
      <span v-if="tree.enrollment.status === 'completed'" class="badge teal">{{ t('learner.badge.completed') }}</span>
    </p>

    <NuxtLink
      v-if="tree.resumeLessonId && tree.enrollment.status !== 'completed'"
      :to="`/learn/${enrollmentId}/${tree.resumeLessonId}`"
      class="primary"
    >
      {{ tree.enrollment.status === 'in_progress' ? t('learner.action.continue') : t('learner.action.start') }}
    </NuxtLink>

    <section v-for="mod in tree.modules" :key="mod.id" class="module">
      <h2>{{ mod.title }}</h2>
      <ul>
        <li v-for="lesson in mod.lessons" :key="lesson.id" :class="['lesson', lesson.status]">
          <NuxtLink
            v-if="lesson.status !== 'locked'"
            :to="`/learn/${enrollmentId}/${lesson.id}`"
            class="lesson-link"
          >
            <span class="icon">{{ icon(lesson.status, lesson.itemType) }}</span>
            <span class="lesson-title">{{ lesson.title }}</span>
            <span v-if="!lesson.isRequired" class="optional">{{ t('learner.optional') }}</span>
          </NuxtLink>
          <span v-else class="lesson-link">
            <span class="icon">{{ icon(lesson.status, lesson.itemType) }}</span>
            <span class="lesson-title">{{ lesson.title }}</span>
          </span>
        </li>
      </ul>
    </section>
  </div>
  <p v-else-if="error" class="error">{{ error }}</p>
</template>

<style scoped>
.back {
  color: var(--color-ink-muted);
  text-decoration: none;
  font-size: var(--font-size-body-s);
}

h1 {
  margin: var(--space-2) 0 var(--space-3);
  font-weight: 900;
}

.progress {
  height: 8px;
  background: var(--color-bg-line-soft);
  border-radius: var(--radius-pill);
  overflow: hidden;
}

.bar {
  height: 100%;
  background: var(--color-teal);
}

.meta {
  color: var(--color-ink-muted);
  font-size: var(--font-size-body-s);
  display: flex;
  gap: var(--space-2);
  align-items: center;
}

.badge.teal {
  background: var(--color-teal);
  color: var(--color-teal-deep);
  border-radius: var(--radius-pill);
  padding: 2px var(--space-3);
  font-weight: 700;
}

.primary {
  display: block;
  text-align: center;
  background: var(--color-sun);
  color: var(--color-ink);
  font-weight: 800;
  border-radius: var(--radius-pill);
  padding: var(--space-3);
  text-decoration: none;
  margin: var(--space-4) 0;
}

.module h2 {
  font-size: var(--font-size-body);
  color: var(--color-ink-muted);
  margin: var(--space-4) 0 var(--space-2);
}

ul {
  list-style: none;
  margin: 0;
  padding: 0;
  display: grid;
  gap: var(--space-2);
}

.lesson-link {
  display: flex;
  align-items: center;
  gap: var(--space-3);
  background: var(--color-bg-soft);
  border-radius: var(--radius-m);
  padding: var(--space-3) var(--space-4);
  text-decoration: none;
  color: var(--color-ink);
}

.lesson.locked .lesson-link {
  opacity: 0.5;
}

.lesson.completed .icon {
  color: var(--color-teal-ink);
  font-weight: 900;
}

.icon {
  width: 20px;
  text-align: center;
  color: var(--color-ink-faint);
}

.lesson-title {
  flex: 1;
  font-weight: 700;
}

.optional {
  font-size: var(--font-size-body-s);
  color: var(--color-ink-faint);
}

.error {
  color: var(--color-coral-ink);
}
</style>
