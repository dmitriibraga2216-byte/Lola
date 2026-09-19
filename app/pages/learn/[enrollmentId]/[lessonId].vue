<script setup lang="ts">
import type { ContentBlock } from '../../../../shared/schemas/content'

definePageMeta({ layout: false })

const { t } = useI18n()
const { api } = useApi()
const route = useRoute()
const enrollmentId = route.params.enrollmentId as string
const lessonId = route.params.lessonId as string

interface Opened {
  lesson: { id: string, title: string, itemType: string, itemId: string, minSeconds: number | null, videoThresholdPct: number, body: ContentBlock[] }
  progress: { status: string, secondsSpent: number, blocksState: Record<string, unknown>, videoPct: number }
}
interface Tree {
  course: { title: string }
  modules: { lessons: { id: string, status: string }[] }[]
  enrollment: { progressPct: string }
}

const data = ref<Opened | null>(null)
const tree = ref<Tree | null>(null)
const error = ref('')
const busy = ref(false)
const secondsSpent = ref(0)
const blocksState = ref<Record<string, unknown>>({})
const videoPct = ref(0)
const offline = ref(false)

const lessonOrder = computed(() => tree.value?.modules.flatMap(m => m.lessons) ?? [])
const position = computed(() => lessonOrder.value.findIndex(l => l.id === lessonId) + 1)
const nextLesson = computed(() => lessonOrder.value[position.value] ?? null)

/** Причина, почему «Далі» ещё неактивна (docs/11 §5.5). Считается локально для подписи, решает сервер. */
const blocker = computed<string | null>(() => {
  if (!data.value) return null
  if (data.value.progress.status === 'completed') return null
  const { lesson } = data.value
  if (lesson.minSeconds && secondsSpent.value < lesson.minSeconds) {
    return t('learner.waitSeconds', { n: lesson.minSeconds - secondsSpent.value })
  }
  for (const block of lesson.body) {
    if (block.type === 'video' && videoPct.value < lesson.videoThresholdPct) return t('learner.watchVideo')
    if (block.type === 'checklist' && block.requireAll) {
      const checked = (blocksState.value[block.id] as number[] | undefined) ?? []
      if (checked.length < block.items.length) return t('learner.checkAll')
    }
  }
  return null
})

let tickTimer: ReturnType<typeof setInterval> | undefined
let pendingBlocks: Record<string, unknown> | null = null

async function tick() {
  if (document.hidden || !data.value || data.value.progress.status === 'completed') return
  try {
    const res = await api<{ secondsSpent: number, videoPct: number }>(
      `/learning/enrollments/${enrollmentId}/lessons/${lessonId}/tick`,
      { method: 'POST', body: { seconds: 15, blocksState: pendingBlocks ?? undefined, videoPct: videoPct.value } },
    )
    secondsSpent.value = res.secondsSpent
    pendingBlocks = null
    offline.value = false
  }
  catch {
    offline.value = true
  }
}

onMounted(async () => {
  try {
    const [opened, treeRes] = await Promise.all([
      api<Opened>(`/learning/enrollments/${enrollmentId}/lessons/${lessonId}/open`, {
        method: 'POST',
        body: { device: window.innerWidth < 768 ? 'mobile' : 'desktop' },
      }),
      api<Tree>(`/learning/enrollments/${enrollmentId}`),
    ])
    // Урок-тест живёт в своём экране (docs/12 §5.4)
    if (opened.lesson.itemType === 'quiz') {
      await navigateTo(`/learn/quiz/${opened.lesson.itemId}?enrollmentId=${enrollmentId}&lessonId=${lessonId}`, { replace: true })
      return
    }
    if (opened.lesson.itemType === 'workshop') {
      await navigateTo(`/learn/workshop/${opened.lesson.itemId}?enrollmentId=${enrollmentId}&lessonId=${lessonId}`, { replace: true })
      return
    }
    data.value = opened
    tree.value = treeRes
    secondsSpent.value = opened.progress.secondsSpent
    blocksState.value = { ...opened.progress.blocksState }
    videoPct.value = opened.progress.videoPct
    tickTimer = setInterval(tick, 15_000)
  }
  catch (err) {
    error.value = apiErrorOf(err).message
  }
})
onUnmounted(() => clearInterval(tickTimer))

function onChecklist(blockId: string, checked: number[]) {
  blocksState.value = { ...blocksState.value, [blockId]: checked }
  pendingBlocks = { ...(pendingBlocks ?? {}), [blockId]: checked }
}

function onVideo(pct: number) {
  videoPct.value = Math.max(videoPct.value, pct)
}

async function next() {
  if (!data.value) return
  busy.value = true
  error.value = ''
  try {
    if (data.value.progress.status !== 'completed') {
      // Досылаем состояние чек-листов перед завершением
      if (pendingBlocks) await tick()
      const res = await api<{ courseCompleted: boolean }>(
        `/learning/enrollments/${enrollmentId}/lessons/${lessonId}/complete`,
        { method: 'POST' },
      )
      if (res.courseCompleted) {
        await navigateTo(`/learn/${enrollmentId}`)
        return
      }
    }
    if (nextLesson.value) await navigateTo(`/learn/${enrollmentId}/${nextLesson.value.id}`)
    else await navigateTo(`/learn/${enrollmentId}`)
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
  <div class="player">
    <header class="top">
      <NuxtLink :to="`/learn/${enrollmentId}`" class="close" :aria-label="t('learner.exit')">✕</NuxtLink>
      <div class="crumbs">
        <div class="course">{{ tree?.course.title }}</div>
        <div class="pos">{{ t('learner.lessonOf', { n: position, total: lessonOrder.length }) }}</div>
      </div>
    </header>

    <div v-if="offline" class="offline">{{ t('learner.offline') }}</div>

    <main class="body">
      <p v-if="error" class="error">{{ error }}</p>
      <template v-if="data">
        <h1>{{ data.lesson.title }}</h1>
        <LessonBlocks
          :blocks="data.lesson.body"
          :blocks-state="blocksState"
          @checklist="onChecklist"
          @video="onVideo"
        />
      </template>
      <div v-else-if="!error" class="skeleton" />
    </main>

    <footer class="bottom">
      <div class="progress">
        <div class="bar" :style="{ width: `${tree?.enrollment.progressPct ?? 0}%` }" />
      </div>
      <div class="row">
        <span class="hint">{{ blocker || '' }}</span>
        <button class="next" :disabled="busy || !!blocker || !data" @click="next">
          {{ nextLesson || data?.progress.status !== 'completed' ? t('learner.next') : t('learner.finish') }}
        </button>
      </div>
    </footer>
  </div>
</template>

<style scoped>
.player {
  min-height: 100dvh;
  display: flex;
  flex-direction: column;
  background: var(--color-bg);
  font-family: var(--font-family);
  color: var(--color-ink);
}

.top {
  display: flex;
  align-items: center;
  gap: var(--space-3);
  padding: var(--space-3) var(--space-4);
  background: var(--color-bg-soft);
  border-bottom: 1px solid var(--color-bg-line);
  position: sticky;
  top: 0;
}

.close {
  width: 36px;
  height: 36px;
  display: grid;
  place-items: center;
  border-radius: var(--radius-pill);
  background: var(--color-bg);
  color: var(--color-ink);
  text-decoration: none;
  font-weight: 800;
}

.course {
  font-weight: 800;
  font-size: var(--font-size-body-s);
}

.pos {
  font-size: var(--font-size-body-s);
  color: var(--color-ink-muted);
}

.offline {
  background: var(--color-sun);
  color: var(--color-sun-ink);
  text-align: center;
  padding: var(--space-2);
  font-size: var(--font-size-body-s);
  font-weight: 700;
}

.body {
  flex: 1;
  padding: var(--space-4);
  padding-bottom: 120px;
  max-width: 720px;
  width: 100%;
  margin: 0 auto;
  box-sizing: border-box;
}

h1 {
  margin: 0 0 var(--space-4);
  font-weight: 900;
}

.skeleton {
  height: 240px;
  background: var(--color-bg-soft);
  border-radius: var(--radius-m);
  opacity: 0.6;
}

.bottom {
  position: fixed;
  bottom: 0;
  left: 0;
  right: 0;
  background: var(--color-bg-soft);
  border-top: 1px solid var(--color-bg-line);
  padding-bottom: env(safe-area-inset-bottom);
}

.progress {
  height: 4px;
  background: var(--color-bg-line-soft);
}

.bar {
  height: 100%;
  background: var(--color-teal);
}

.row {
  display: flex;
  align-items: center;
  justify-content: space-between;
  gap: var(--space-3);
  padding: var(--space-3) var(--space-4);
  max-width: 720px;
  margin: 0 auto;
}

.hint {
  font-size: var(--font-size-body-s);
  color: var(--color-ink-muted);
}

.next {
  font: inherit;
  font-weight: 800;
  border: none;
  background: var(--color-sun);
  color: var(--color-ink);
  border-radius: var(--radius-pill);
  padding: var(--space-3) var(--space-6);
  cursor: pointer;
}

.next:disabled {
  opacity: 0.4;
  cursor: default;
}

.error {
  color: var(--color-coral-ink);
}
</style>
