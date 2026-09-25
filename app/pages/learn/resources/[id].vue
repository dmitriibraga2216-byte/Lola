<script setup lang="ts">
import type { ContentBlock } from '../../../../shared/schemas/content'

/**
 * Ресурс как задание — узел траектории «Завдання», элемент программы (docs/11 Г-11.5, §5.5;
 * раскладка мокапа Lesson): шапка «← · Ресурс», тело по типу материала (сторінка / відео /
 * файл / посилання), липкий низ «Ще N секунд · Завершити». Клиент шлёт факты тиком; что
 * пройдено, решает сервер, и он же двигает траекторию (CLAUDE.md п. 3). После зачёта человек
 * возвращается туда, откуда пришёл, — узел в ленте уже отмечен.
 */
definePageMeta({ layout: false })

const { t } = useI18n()
const { api } = useApi()
const route = useRoute()
const resourceId = route.params.id as string
const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i
const queryId = (v: unknown) => typeof v === 'string' && UUID.test(v) ? v : undefined
/** Назначение, по которому человек проходит материал (узел траектории, прямое). */
const assignmentId = queryId(route.query.assignmentId)
/** Элемент программы: назначения нет, вернуться — в ленту программы. */
const programEnrollmentId = queryId(route.query.program)

type ReasonCode = 'read_to_end' | 'watch_video' | 'scroll_doc' | 'ack_link' | 'check_all' | 'time'
interface PassState {
  status: 'opened' | 'completed'
  secondsSpent: number
  scrollPct: number
  videoPct: number
  acknowledged: boolean
  downloaded: boolean
  blocksState: Record<string, unknown>
  ready: boolean
  reasons: string[]
  requiredSeconds: number | null
  missing: ReasonCode[]
}
interface Opened {
  resource: {
    id: string, title: string, kind: 'article' | 'file' | 'video' | 'link', body: ContentBlock[]
    mediaId: string | null, externalUrl: string | null, version: number, pinned: boolean, canPrint: boolean
    videoThresholdPct: number
  }
  progress: PassState
  context: { type: 'trajectory', enrollmentId: string, title: string | null } | null
}
interface Media { urls: Record<string, string>, status: string, originalName: string }

/** Код причины → подпись на языке интерфейса (сервер отдаёт коды, `lessonRules.REASONS`). */
const REASON_KEY: Record<Exclude<ReasonCode, 'time'>, string> = {
  read_to_end: 'learner.readToEnd',
  watch_video: 'learner.watchVideo',
  scroll_doc: 'learner.scrollDoc',
  ack_link: 'learner.ackLink',
  check_all: 'learner.checkAll',
}

const data = ref<Opened | null>(null)
const media = ref<Media | null>(null)
const error = ref('')
const notice = ref('')
const busy = ref(false)
const offline = ref(false)
const secondsSpent = ref(0)
const scrollPct = ref(0)
const videoPct = ref(0)
const acknowledged = ref(false)
const downloaded = ref(false)
const blocksState = ref<Record<string, unknown>>({})
const serverReady = ref(false)
const missing = ref<ReasonCode[]>([])
const requiredSeconds = ref<number | null>(null)
const completed = ref(false)
const bodyEl = ref<HTMLElement | null>(null)

const backTo = computed(() => data.value?.context?.type === 'trajectory'
  ? `/learn/trajectories/${data.value.context.enrollmentId}`
  : programEnrollmentId ? `/learn/programs/${programEnrollmentId}` : '/learn')
const backLabel = computed(() => data.value?.context?.type === 'trajectory'
  ? t('resourcePass.toTrajectory')
  : programEnrollmentId ? t('resourcePass.toProgram') : t('learner.nav.learning'))

/** Чек-листы с require_all, ещё не отмеченные локально (docs/11 §3.3). */
const checklistsLeft = computed(() => (data.value?.resource.body ?? []).some(b =>
  b.type === 'checklist' && b.requireAll && ((blocksState.value[b.id] as number[] | undefined) ?? []).length < b.items.length))

/**
 * Подпись под кнопкой (docs/11 §5.5). Решает сервер — «Завершити» активна, когда он ответил ready;
 * локально лишь обратный отсчёт и факты, которые клиент уже знает, но ещё не досдал тиком.
 */
const hint = computed<string | null>(() => {
  if (!data.value || completed.value) return null
  const parts: string[] = []
  const required = requiredSeconds.value ?? 0
  if (required && secondsSpent.value < required) parts.push(t('resourcePass.remaining', { n: required - secondsSpent.value }))
  for (const code of missing.value) {
    if (code === 'time') continue
    if (code === 'read_to_end' && scrollPct.value >= 100) continue
    if (code === 'scroll_doc' && (scrollPct.value >= 100 || downloaded.value)) continue
    if (code === 'watch_video' && videoPct.value >= data.value.resource.videoThresholdPct) continue
    if (code === 'ack_link' && acknowledged.value) continue
    if (code === 'check_all' && !checklistsLeft.value) continue
    parts.push(t(REASON_KEY[code]))
  }
  if (checklistsLeft.value && !missing.value.includes('check_all')) parts.push(t('learner.checkAll'))
  return parts.length ? [...new Set(parts)].join(' · ') : null
})
const canComplete = computed(() => !!data.value && !completed.value && serverReady.value && !checklistsLeft.value)

function apply(s: PassState) {
  secondsSpent.value = s.secondsSpent
  scrollPct.value = Math.max(scrollPct.value, s.scrollPct)
  videoPct.value = Math.max(videoPct.value, s.videoPct)
  acknowledged.value = s.acknowledged
  downloaded.value = s.downloaded
  serverReady.value = s.ready
  missing.value = s.missing
  if (s.requiredSeconds != null) requiredSeconds.value = s.requiredSeconds
  completed.value = s.status === 'completed'
}

let tickTimer: ReturnType<typeof setTimeout> | undefined
let localTimer: ReturnType<typeof setInterval> | undefined
let pendingBlocks: Record<string, unknown> | null = null
let lastTickAt = 0
const TICK_EVERY_MS = 15_000
const TICK_MIN_MS = 10_000 // сервер не засчитывает тики чаще (docs/11 §7.4)

/** Следующий тик: обычно через 15 с; если не хватает только времени — когда оно наберётся (но не чаще раза в 10 с). */
function scheduleTick() {
  clearTimeout(tickTimer)
  if (!data.value || completed.value) return
  const required = requiredSeconds.value ?? 0
  const remaining = required > secondsSpent.value ? (required - secondsSpent.value) * 1000 : TICK_EVERY_MS
  const delay = Math.max(TICK_MIN_MS - (Date.now() - lastTickAt), Math.min(TICK_EVERY_MS, remaining))
  tickTimer = setTimeout(() => tick(), Math.max(250, delay))
}

async function tick() {
  if (!data.value || completed.value) return
  if (document.hidden) { scheduleTick(); return }
  const seconds = lastTickAt ? Math.min(60, Math.round((Date.now() - lastTickAt) / 1000)) : 15
  try {
    const res = await api<PassState>(`/learning/resources/${resourceId}/tick`, {
      method: 'POST',
      body: { assignmentId, seconds, scrollPct: scrollPct.value, videoPct: videoPct.value, blocksState: pendingBlocks ?? undefined },
    })
    lastTickAt = Date.now()
    pendingBlocks = null
    offline.value = false
    apply(res)
  }
  catch {
    offline.value = true
  }
  scheduleTick()
}

function measureScroll() {
  if (!bodyEl.value) return
  const doc = document.documentElement
  const scrollable = doc.scrollHeight - window.innerHeight
  const pct = scrollable <= 8 ? 100 : Math.min(100, Math.round((window.scrollY + window.innerHeight) / doc.scrollHeight * 100))
  if (pct > scrollPct.value) scrollPct.value = pct
}

onMounted(async () => {
  try {
    const opened = await api<Opened>(`/learning/resources/${resourceId}/open`, {
      method: 'POST',
      body: { assignmentId, device: window.innerWidth < 768 ? 'mobile' : 'desktop' },
    })
    data.value = opened
    blocksState.value = { ...opened.progress.blocksState }
    apply(opened.progress)
    if (opened.resource.mediaId) {
      try { media.value = await api<Media>(`/media/${opened.resource.mediaId}`) }
      catch { /* тело покажет, что видео/файл ещё не готовы */ }
    }
    lastTickAt = Date.now()
    scheduleTick()
    // Локальный счётчик только для подписи «Ще N секунд»; засчитывает сервер по тикам
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
  scheduleTick()
}
function onVideo(pct: number) {
  videoPct.value = Math.max(videoPct.value, pct)
}
function onVideoTime(e: Event) {
  const v = e.target as HTMLVideoElement
  if (v.duration) onVideo(Math.floor(v.currentTime / v.duration * 100))
}

async function acknowledge() {
  error.value = ''
  try { apply(await api<PassState>(`/learning/resources/${resourceId}/acknowledge`, { method: 'POST', body: { assignmentId } })) }
  catch (err) { error.value = apiErrorOf(err).message }
}

async function download() {
  if (!data.value?.resource.mediaId) return
  window.open(`/api/v1/media/${data.value.resource.mediaId}?redirect=1`, '_blank', 'noopener')
  try { apply(await api<PassState>(`/learning/resources/${resourceId}/download`, { method: 'POST', body: { assignmentId } })) }
  catch (err) { error.value = apiErrorOf(err).message }
}

function print() {
  window.print()
}

async function complete() {
  if (!data.value || completed.value) return
  busy.value = true
  error.value = ''
  try {
    if (pendingBlocks) await tick() // досылаем отмеченные пункты; решение — за сервером
    await api(`/learning/resources/${resourceId}/complete`, { method: 'POST', body: { assignmentId } })
    completed.value = true
    notice.value = t('resourcePass.completed')
    clearTimeout(tickTimer)
    await navigateTo(backTo.value)
  }
  catch (err) {
    const e = apiErrorOf(err) as { message: string, details?: { missing?: ReasonCode[] } }
    if (e.details?.missing) { missing.value = e.details.missing; serverReady.value = false }
    error.value = e.details?.missing ? t('resourcePass.notYet') : e.message
  }
  finally {
    busy.value = false
  }
}
</script>

<template>
  <div :class="['player', { 'no-print': data && !data.resource.canPrint }]">
    <header class="top">
      <NuxtLink :to="backTo" class="close" :aria-label="backLabel">←</NuxtLink>
      <div class="crumbs">
        <div class="context">{{ data?.context?.title || t('contentType.resource') }}</div>
      </div>
      <button v-if="data?.resource.canPrint" type="button" class="print-btn" :aria-label="t('resource.print')" @click="print">⎙</button>
    </header>

    <div v-if="offline" class="offline" role="status">{{ t('learner.offline') }}</div>

    <main ref="bodyEl" class="body">
      <p v-if="error" class="error" role="alert">{{ error }}</p>
      <p v-if="notice" class="note teal" role="status">{{ notice }}</p>
      <template v-if="data">
        <div class="kind-label">{{ t(`resource.kind.${data.resource.kind}`).toUpperCase() }}</div>
        <h1>{{ data.resource.title }}</h1>

        <template v-if="data.resource.kind === 'video'">
          <video
            v-if="media?.status === 'ready' && media.urls.original"
            class="video" controls playsinline preload="metadata"
            :poster="media.urls.poster" :src="media.urls.original" :aria-label="data.resource.title"
            @timeupdate="onVideoTime"
          />
          <p v-else class="note sun">{{ t('resource.videoNotReady') }}</p>
        </template>

        <template v-else-if="data.resource.kind === 'file'">
          <div class="file-card card">
            <b>{{ media?.originalName ?? data.resource.title }}</b>
            <button type="button" class="btn primary" @click="download">{{ t('resource.download') }}</button>
          </div>
          <iframe v-if="media?.urls.original" class="doc" :src="media.urls.original" :title="data.resource.title" />
        </template>

        <template v-else-if="data.resource.kind === 'link'">
          <div class="file-card card">
            <a :href="data.resource.externalUrl ?? '#'" target="_blank" rel="noopener noreferrer" class="btn ghost">{{ t('resource.openLink') }} ↗</a>
            <button type="button" class="btn primary" :disabled="acknowledged" @click="acknowledge">{{ acknowledged ? t('resource.acknowledged') : t('resource.acknowledge') }}</button>
          </div>
        </template>

        <LessonBlocks
          v-if="data.resource.body.length"
          :blocks="data.resource.body"
          :blocks-state="blocksState"
          :readonly="completed"
          @checklist="onChecklist"
          @video="onVideo"
        />
        <p v-else-if="data.resource.kind === 'article'" class="muted">{{ t('resourcePass.empty') }}</p>
      </template>
      <div v-else-if="!error" class="skeleton" />
    </main>

    <footer class="bottom">
      <div class="row">
        <span class="hint" aria-live="polite">{{ completed ? t('resourcePass.completed') : hint || '' }}</span>
        <NuxtLink v-if="completed" :to="backTo" class="next">{{ backLabel }}</NuxtLink>
        <button v-else type="button" class="next" :disabled="busy || !canComplete" @click="complete">{{ t('resourcePass.complete') }}</button>
      </div>
    </footer>
  </div>
</template>

<style scoped>
.player { min-height: 100dvh; display: flex; flex-direction: column; background: var(--color-bg); font-family: var(--font-family); color: var(--color-ink); }
.top { display: flex; align-items: center; gap: var(--space-3); padding: var(--space-3) var(--space-4); background: var(--color-bg-soft); border-bottom: 1px solid var(--color-bg-line); position: sticky; top: 0; z-index: 2; }
.close { width: 36px; height: 36px; display: grid; place-items: center; border-radius: var(--radius-pill); background: var(--color-bg); color: var(--color-ink); text-decoration: none; font-weight: 800; flex: none; }
.crumbs { flex: 1; min-width: 0; }
.context { font-weight: 800; font-size: var(--font-size-body-s); overflow: hidden; text-overflow: ellipsis; white-space: nowrap; }
.print-btn { font: inherit; border: none; background: var(--color-bg); border-radius: var(--radius-pill); width: 36px; height: 36px; cursor: pointer; color: var(--color-ink); flex: none; }
.offline { background: var(--color-sun); color: var(--color-sun-ink); text-align: center; padding: var(--space-2); font-size: var(--font-size-body-s); font-weight: 700; }
.body { flex: 1; padding: var(--space-4); padding-bottom: 120px; max-width: 720px; width: 100%; margin: 0 auto; box-sizing: border-box; overflow-wrap: anywhere; }
.kind-label { font-size: var(--font-size-body-s); font-weight: 800; letter-spacing: 0.06em; color: var(--color-ink-muted); margin-bottom: var(--space-1); }
h1 { margin: 0 0 var(--space-4); font-weight: 900; }
.video { width: 100%; border-radius: var(--radius-m); background: var(--color-teal); display: block; margin-bottom: var(--space-4); }
.file-card { display: flex; align-items: center; justify-content: space-between; gap: var(--space-3); flex-wrap: wrap; margin-bottom: var(--space-4); }
.doc { width: 100%; height: 70vh; border: 1px solid var(--color-bg-line-soft); border-radius: var(--radius-m); background: var(--color-bg-soft); }
.skeleton { height: 240px; background: var(--color-bg-soft); border-radius: var(--radius-m); opacity: 0.6; }
.bottom { position: fixed; bottom: 0; left: 0; right: 0; background: var(--color-bg-soft); border-top: 1px solid var(--color-bg-line); padding-bottom: env(safe-area-inset-bottom); }
.row { display: flex; align-items: center; justify-content: space-between; gap: var(--space-3); padding: var(--space-3) var(--space-4); max-width: 720px; margin: 0 auto; }
.hint { font-size: var(--font-size-body-s); color: var(--color-ink-muted); font-weight: 700; min-width: 0; }
.next { font: inherit; font-weight: 800; border: none; background: var(--color-sun); color: var(--color-ink); border-radius: var(--radius-pill); padding: var(--space-3) var(--space-6); cursor: pointer; flex: none; text-decoration: none; }
.next:disabled { opacity: 0.4; cursor: default; }
.next:focus-visible, .close:focus-visible, .print-btn:focus-visible { outline: 2px solid var(--color-ink); outline-offset: 2px; }
.error { color: var(--color-coral-ink); font-weight: 700; }
@media (max-width: 360px) {
  .row { flex-wrap: wrap; }
  .next { width: 100%; text-align: center; padding: var(--space-3) var(--space-4); }
}
@media print {
  .top, .bottom, .offline, .file-card { display: none; }
  .body { padding: 0; max-width: none; }
  .no-print .body { display: none; } /* «Дозволити друк» выключен или политика «Вимкнути друк у ресурсах» */
}
</style>
