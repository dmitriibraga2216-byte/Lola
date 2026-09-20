<script setup lang="ts">
import type { ContentBlock } from '../../../../shared/schemas/content'

/**
 * Плеер урока по мокапу Lesson (docs/11 §5.5, Г-11.5): шапка «← · 3 з 5», подпись «РОЗДІЛ 2 · …»,
 * тело по типу материала (сторінка / відео / файл / посилання), низ «Ще N секунд до кінця уроку · Далі».
 * Клиент шлёт факты тиком {seconds, scrollPct, videoPct}; что считается пройденным — решает сервер (CLAUDE.md п. 3).
 */
definePageMeta({ layout: false })

const { t } = useI18n()
const { api } = useApi()
const route = useRoute()
const enrollmentId = route.params.enrollmentId as string
const lessonId = route.params.lessonId as string

interface Opened {
  lesson: {
    id: string, title: string, itemType: string, itemId: string, minSeconds: number | null, videoThresholdPct: number, body: ContentBlock[]
    kind: 'article' | 'file' | 'video' | 'link' | null, mediaId: string | null, externalUrl: string | null
    requiredSeconds: number | null, canPrint: boolean, section: { title: string, number: number } | null
  }
  progress: { status: string, secondsSpent: number, blocksState: Record<string, unknown>, videoPct: number, scrollPct: number, acknowledged: boolean, downloaded: boolean, ready: boolean, reasons: string[] }
}
interface TickRes { secondsSpent: number, videoPct: number, scrollPct: number, ready: boolean, reasons: string[], requiredSeconds: number | null }
interface Tree {
  course: { title: string }
  modules: { lessons: { id: string, status: string }[] }[]
  enrollment: { progressPct: string }
}
interface Media { urls: Record<string, string>, status: string, originalName: string }

const data = ref<Opened | null>(null)
const tree = ref<Tree | null>(null)
const media = ref<Media | null>(null)
const error = ref('')
const busy = ref(false)
const secondsSpent = ref(0)
const blocksState = ref<Record<string, unknown>>({})
const videoPct = ref(0)
const scrollPct = ref(0)
const acknowledged = ref(false)
const downloaded = ref(false)
const serverReady = ref(false)
const serverReasons = ref<string[]>([])
const offline = ref(false)
const bodyEl = ref<HTMLElement | null>(null)

const lessonOrder = computed(() => tree.value?.modules.flatMap(m => m.lessons) ?? [])
const position = computed(() => lessonOrder.value.findIndex(l => l.id === lessonId) + 1)
const nextLesson = computed(() => lessonOrder.value[position.value] ?? null)
const completed = computed(() => data.value?.progress.status === 'completed')

/** Чек-листы с require_all, ещё не отмеченные локально (docs/11 §3.3). */
const checklistsLeft = computed(() => (data.value?.lesson.body ?? []).some(b =>
  b.type === 'checklist' && b.requireAll && ((blocksState.value[b.id] as number[] | undefined) ?? []).length < b.items.length))

/**
 * Подпись под кнопкой (docs/11 §5.5). Решает сервер: «Далі» активна только когда он ответил ready.
 * Локально лишь уточняем подпись: обратный отсчёт времени и факты, которые клиент уже знает
 * (доскроллил, отметил пункты), но ещё не досдал тиком.
 */
const blocker = computed<string | null>(() => {
  if (!data.value || completed.value) return null
  const required = data.value.lesson.requiredSeconds ?? 0
  const parts: string[] = []
  if (required && secondsSpent.value < required) parts.push(t('learner.remaining', { n: required - secondsSpent.value }))
  for (const r of serverReasons.value) {
    if (r.startsWith('Ще ')) continue
    if (r === t('learner.readToEnd') && scrollPct.value >= 100) continue
    if (r === t('learner.checkAll') && !checklistsLeft.value) continue
    if (r === t('learner.watchVideo') && videoPct.value >= data.value.lesson.videoThresholdPct) continue
    if (r === t('learner.scrollDoc') && (scrollPct.value >= 100 || downloaded.value)) continue
    if (r === t('learner.ackLink') && acknowledged.value) continue
    parts.push(r)
  }
  if (checklistsLeft.value && !parts.includes(t('learner.checkAll'))) parts.push(t('learner.checkAll'))
  return parts.length ? parts.join(' · ') : null
})
const canProceed = computed(() => !!data.value && (completed.value || (serverReady.value && !checklistsLeft.value)))

let tickTimer: ReturnType<typeof setTimeout> | undefined
let localTimer: ReturnType<typeof setInterval> | undefined
let pendingBlocks: Record<string, unknown> | null = null
let lastTickAt = 0
const TICK_EVERY_MS = 15_000
const TICK_MIN_MS = 10_000 // сервер не засчитывает тики чаще (docs/11 §7.4)

function applyTick(res: TickRes) {
  secondsSpent.value = res.secondsSpent
  videoPct.value = Math.max(videoPct.value, res.videoPct)
  scrollPct.value = Math.max(scrollPct.value, res.scrollPct)
  serverReady.value = res.ready
  serverReasons.value = res.reasons
}

/** Следующий тик: обычно через 15 с; если не хватает только времени — ровно когда оно наберётся (но не чаще раза в 10 с). */
function scheduleTick() {
  clearTimeout(tickTimer)
  if (!data.value || completed.value) return
  const required = data.value.lesson.requiredSeconds ?? 0
  const remaining = required > secondsSpent.value ? (required - secondsSpent.value) * 1000 : TICK_EVERY_MS
  const sinceLast = Date.now() - lastTickAt
  const delay = Math.max(TICK_MIN_MS - sinceLast, Math.min(TICK_EVERY_MS, remaining))
  tickTimer = setTimeout(() => tick(), Math.max(250, delay))
}

async function tick() {
  if (!data.value || completed.value) return
  if (document.hidden) { scheduleTick(); return }
  const seconds = lastTickAt ? Math.min(60, Math.round((Date.now() - lastTickAt) / 1000)) : 15
  try {
    const res = await api<TickRes>(
      `/learning/enrollments/${enrollmentId}/lessons/${lessonId}/tick`,
      { method: 'POST', body: { seconds, scrollPct: scrollPct.value, videoPct: videoPct.value, blocksState: pendingBlocks ?? undefined } },
    )
    lastTickAt = Date.now()
    applyTick(res)
    pendingBlocks = null
    offline.value = false
  }
  catch {
    offline.value = true
  }
  scheduleTick()
}

function measureScroll() {
  const el = bodyEl.value
  if (!el) return
  const doc = document.documentElement
  const scrollable = doc.scrollHeight - window.innerHeight
  const pct = scrollable <= 8 ? 100 : Math.min(100, Math.round((window.scrollY + window.innerHeight) / doc.scrollHeight * 100))
  if (pct > scrollPct.value) scrollPct.value = pct
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
    // Урок-тест и практикум живут в своих экранах (docs/12 §5.4)
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
    scrollPct.value = opened.progress.scrollPct
    acknowledged.value = opened.progress.acknowledged
    downloaded.value = opened.progress.downloaded
    serverReady.value = opened.progress.ready
    serverReasons.value = opened.progress.reasons
    if (opened.lesson.mediaId) {
      try { media.value = await api<Media>(`/media/${opened.lesson.mediaId}`) }
      catch { /* блок покажет ошибку */ }
    }
    lastTickAt = Date.now()
    scheduleTick()
    // Локальный счётчик только для подписи «Ще N секунд»; сервер считает своё
    localTimer = setInterval(() => { if (!document.hidden && !completed.value) secondsSpent.value++ }, 1000)
    window.addEventListener('scroll', measureScroll, { passive: true })
    nextTick(measureScroll)
  }
  catch (err) {
    error.value = apiErrorOf(err).message
  }
})
onUnmounted(() => {
  clearTimeout(tickTimer)
  clearInterval(localTimer)
  window.removeEventListener('scroll', measureScroll)
})

function onChecklist(blockId: string, checked: number[]) {
  blocksState.value = { ...blocksState.value, [blockId]: checked }
  pendingBlocks = { ...(pendingBlocks ?? {}), [blockId]: checked }
  scheduleTick() // досылаем состояние, как только сервер готов принять
}

function onVideo(pct: number) {
  videoPct.value = Math.max(videoPct.value, pct)
}

function onVideoTime(e: Event) {
  const v = e.target as HTMLVideoElement
  if (v.duration) onVideo(Math.floor(v.currentTime / v.duration * 100))
}

async function acknowledge() {
  try {
    applyTick(await api<TickRes>(`/learning/enrollments/${enrollmentId}/lessons/${lessonId}/acknowledge`, { method: 'POST' }))
    acknowledged.value = true
  }
  catch (err) {
    error.value = apiErrorOf(err).message
  }
}

async function download() {
  if (!data.value?.lesson.mediaId) return
  window.open(`/api/v1/media/${data.value.lesson.mediaId}?redirect=1`, '_blank', 'noopener')
  try {
    applyTick(await api<TickRes>(`/learning/enrollments/${enrollmentId}/lessons/${lessonId}/download`, { method: 'POST' }))
    downloaded.value = true
  }
  catch (err) {
    error.value = apiErrorOf(err).message
  }
}

function print() {
  window.print()
}

async function next() {
  if (!data.value) return
  busy.value = true
  error.value = ''
  try {
    if (!completed.value) {
      // Досылаем факты перед завершением; решение принимает сервер
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
    const e = apiErrorOf(err) as { message: string, details?: { reasons?: string[] } }
    if (e.details?.reasons?.length) serverReasons.value = e.details.reasons
    error.value = e.message
  }
  finally {
    busy.value = false
  }
}
</script>

<template>
  <div :class="['player', { 'no-print': data && !data.lesson.canPrint }]">
    <header class="top">
      <NuxtLink :to="`/learn/${enrollmentId}`" class="close" :aria-label="t('learner.exit')">←</NuxtLink>
      <div class="crumbs">
        <div class="course">{{ tree?.course.title }}</div>
      </div>
      <div class="pos">{{ t('learner.lessonOf', { n: position, total: lessonOrder.length }) }}</div>
      <button v-if="data?.lesson.canPrint" class="print-btn" :aria-label="t('resource.print')" @click="print">⎙</button>
    </header>

    <div v-if="offline" class="offline">{{ t('learner.offline') }}</div>

    <main ref="bodyEl" class="body">
      <p v-if="error" class="error" role="alert">{{ error }}</p>
      <template v-if="data">
        <div v-if="data.lesson.section" class="section-label">{{ t('learner.sectionLabel', { n: data.lesson.section.number, title: data.lesson.section.title }).toUpperCase() }}</div>
        <h1>{{ data.lesson.title }}</h1>

        <template v-if="data.lesson.kind === 'video'">
          <div v-if="media?.status === 'ready' && media.urls.original" class="video-wrap">
            <video controls playsinline preload="metadata" :poster="media.urls.poster" :src="media.urls.original" @timeupdate="onVideoTime" />
            <span class="sub">{{ t('learner.videoOf') }} · {{ videoPct }}%</span>
          </div>
          <p v-else class="note sun">{{ t('resource.videoNotReady') }}</p>
        </template>

        <template v-else-if="data.lesson.kind === 'file'">
          <div class="file-card card">
            <b>{{ media?.originalName ?? data.lesson.title }}</b>
            <button class="btn primary" @click="download">{{ t('resource.download') }}</button>
          </div>
          <iframe v-if="media?.urls.original" class="doc" :src="media.urls.original" :title="data.lesson.title" />
        </template>

        <template v-else-if="data.lesson.kind === 'link'">
          <div class="file-card card">
            <a :href="data.lesson.externalUrl ?? '#'" target="_blank" rel="noopener noreferrer" class="btn ghost">{{ t('resource.openLink') }} ↗</a>
            <button class="btn primary" :disabled="acknowledged" @click="acknowledge">{{ acknowledged ? t('resource.acknowledged') : t('resource.acknowledge') }}</button>
          </div>
        </template>

        <LessonBlocks
          v-if="data.lesson.body.length"
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
        <span class="hint" aria-live="polite">{{ blocker || '' }}</span>
        <button class="next" :disabled="busy || !canProceed" @click="next">
          {{ nextLesson || !completed ? t('learner.next') : t('learner.finish') }}
        </button>
      </div>
    </footer>
  </div>
</template>

<style scoped>
.player { min-height: 100dvh; display: flex; flex-direction: column; background: var(--color-bg); font-family: var(--font-family); color: var(--color-ink); }
.top { display: flex; align-items: center; gap: var(--space-3); padding: var(--space-3) var(--space-4); background: var(--color-bg-soft); border-bottom: 1px solid var(--color-bg-line); position: sticky; top: 0; z-index: 2; }
.close { width: 36px; height: 36px; display: grid; place-items: center; border-radius: var(--radius-pill); background: var(--color-bg); color: var(--color-ink); text-decoration: none; font-weight: 800; flex: none; }
.crumbs { flex: 1; min-width: 0; }
.course { font-weight: 800; font-size: var(--font-size-body-s); overflow: hidden; text-overflow: ellipsis; white-space: nowrap; }
.pos { font-size: var(--font-size-body-s); color: var(--color-ink-muted); font-weight: 700; white-space: nowrap; }
.print-btn { font: inherit; border: none; background: var(--color-bg); border-radius: var(--radius-pill); width: 36px; height: 36px; cursor: pointer; color: var(--color-ink); }
.offline { background: var(--color-sun); color: var(--color-sun-ink); text-align: center; padding: var(--space-2); font-size: var(--font-size-body-s); font-weight: 700; }
.body { flex: 1; padding: var(--space-4); padding-bottom: 120px; max-width: 720px; width: 100%; margin: 0 auto; box-sizing: border-box; }
.section-label { font-size: 12px; font-weight: 800; letter-spacing: 0.06em; color: var(--color-ink-muted); margin-bottom: var(--space-1); }
h1 { margin: 0 0 var(--space-4); font-weight: 900; }
.video-wrap { display: grid; gap: var(--space-1); margin-bottom: var(--space-4); }
.video-wrap video { width: 100%; border-radius: var(--radius-m); background: var(--color-ink); }
.file-card { display: flex; align-items: center; justify-content: space-between; gap: var(--space-3); flex-wrap: wrap; margin-bottom: var(--space-4); }
.doc { width: 100%; height: 70vh; border: 1px solid var(--color-bg-line-soft); border-radius: var(--radius-m); background: var(--color-bg-soft); }
.skeleton { height: 240px; background: var(--color-bg-soft); border-radius: var(--radius-m); opacity: 0.6; }
.bottom { position: fixed; bottom: 0; left: 0; right: 0; background: var(--color-bg-soft); border-top: 1px solid var(--color-bg-line); padding-bottom: env(safe-area-inset-bottom); }
.progress { height: 4px; background: var(--color-bg-line-soft); }
.bar { height: 100%; background: var(--color-teal); }
.row { display: flex; align-items: center; justify-content: space-between; gap: var(--space-3); padding: var(--space-3) var(--space-4); max-width: 720px; margin: 0 auto; }
.hint { font-size: var(--font-size-body-s); color: var(--color-ink-muted); font-weight: 700; }
.next { font: inherit; font-weight: 800; border: none; background: var(--color-sun); color: var(--color-ink); border-radius: var(--radius-pill); padding: var(--space-3) var(--space-6); cursor: pointer; flex: none; }
.next:disabled { opacity: 0.4; cursor: default; }
.error { color: var(--color-coral-ink); }
@media print {
  .top, .bottom, .offline, .file-card, .print-btn { display: none; }
  .body { padding: 0; max-width: none; }
  .no-print .body { display: none; } /* «Дозволити друк» выключен или политика «Вимкнути друк у ресурсах» */
}
</style>
