<script setup lang="ts">
import type { ContentBlock } from '../../../../shared/schemas/content'
const { formatDateTime } = useFormat()

definePageMeta({ layout: false })

const { t } = useI18n()
const { api } = useApi()
const route = useRoute()
const workshopId = route.params.workshopId as string
const enrollmentId = (route.query.enrollmentId as string) || undefined
const lessonId = (route.query.lessonId as string) || undefined

interface Criterion { id: string, text: string, isCritical: boolean }
interface Sub { id: string, status: string, attemptNo: number, mentorRating: number | null, reviewerId: string | null, body: { text?: string }, files: { mediaId: string, name: string, kind: string, bytes: number }[], reviewComment: string | null, criteriaResults: { criterionId: string, passed: boolean, comment?: string }[] | null, reworkCount: number, slaDueAt: string | null, score: string | null }
interface W {
  id: string, title: string, description: ContentBlock[], submissionKinds: string[], minTextLength: number | null, maxFiles: number, maxFileMb: number, allowCameraOnly: boolean,
  criteria: Criterion[], slaHours: number, current: Sub | null, history: { attemptNo: number, status: string, submittedAt: string | null, reviewComment: string | null }[], comments: { id: string, authorName: string, body: string, createdAt: string }[]
}

const w = ref<W | null>(null)
const text = ref('')
const files = ref<{ mediaId: string, name: string, kind: string, bytes: number }[]>([])
const uploading = ref(false)
const busy = ref(false)
const error = ref('')
const comment = ref('')
// Мокап Workshop: приєднані фото — квадратні плитки-мініатюри, не рядок з іменем файлу.
const mediaUrls = ref<Record<string, { urls: Record<string, string> }>>({})
async function loadThumb(mediaId: string) {
  if (mediaUrls.value[mediaId]) return
  try { mediaUrls.value[mediaId] = await api(`/media/${mediaId}`) }
  catch { /* мініатюра лишиться заглушкою */ }
}
function thumbSrc(mediaId: string): string | undefined {
  const m = mediaUrls.value[mediaId]
  return m?.urls['768'] || m?.urls.original
}

async function load() {
  try {
    w.value = await api<W>(`/learning/workshops/${workshopId}`, { query: enrollmentId ? { enrollmentId } : {} })
    if (w.value.current && ['draft', 'rework'].includes(w.value.current.status)) {
      text.value = w.value.current.body.text ?? ''
      files.value = w.value.current.files
    }
    await Promise.all(files.value.filter(f => f.kind === 'photo').map(f => loadThumb(f.mediaId)))
  }
  catch (err) {
    error.value = apiErrorOf(err).message
  }
}
onMounted(load)

const editable = computed(() => !w.value?.current || ['draft', 'rework'].includes(w.value.current.status))

/**
 * Время биениями (docs/v2/37 §7.12, PR-21): чтение задания — «Час на контент», работа над
 * сдачей — «Час на випробування». Форма сдачи живёт на том же экране, поэтому «открытие
 * формы» — первое касание её полей (Р-21.10); после отправки экран времени не меряет.
 */
const time = useLearningTime({ subjectType: 'workshop', subjectId: workshopId, enrollmentId })
const stillHere = time.stillHere
const workingOnForm = ref(false)
watchEffect(() => time.setKind(!w.value || !editable.value ? null : workingOnForm.value ? 'attempt' : 'content'))
const canSubmit = computed(() => {
  if (!w.value || !editable.value) return false
  const hasText = text.value.trim().length >= (w.value.minTextLength ?? 1)
  return w.value.submissionKinds.includes('text') ? (hasText || files.value.length > 0) : files.value.length > 0
})
const hint = computed(() => {
  if (!w.value || !editable.value) return ''
  if (w.value.minTextLength && text.value.trim().length < w.value.minTextLength) return t('workshop.minChars', { n: w.value.minTextLength })
  return ''
})

async function addFile(e: Event) {
  const file = (e.target as HTMLInputElement).files?.[0]
  if (!file || !w.value) return
  if (files.value.length >= w.value.maxFiles) { error.value = t('workshop.maxFiles', { n: w.value.maxFiles }); return }
  if (file.size > w.value.maxFileMb * 1024 * 1024) { error.value = t('workshop.tooBig', { n: w.value.maxFileMb }); return }
  uploading.value = true
  error.value = ''
  try {
    // origin обязателен (docs/v2/34 §7.1): файл сдачи практикума — кандидат в доказательства,
    // признак is_evidence ставится сервером при принятом решении по сдаче (§7.1 п. 2)
    const { mediaId, uploadUrl } = await api<{ mediaId: string, uploadUrl: string }>('/media/upload-url', { method: 'POST', body: { filename: file.name, mime: file.type, bytes: file.size, origin: 'workshop_submission', sourceEntity: 'workshops', sourceId: w.value.id, ...(enrollmentId ? { enrollmentId } : {}) } })
    await fetch(uploadUrl, { method: 'PUT', body: file, headers: { 'Content-Type': file.type } })
    await api(`/media/${mediaId}/complete`, { method: 'POST' })
    files.value.push({ mediaId, name: file.name, kind: file.type.startsWith('image/') ? 'photo' : file.type.startsWith('video/') ? 'video' : 'file', bytes: file.size })
    await loadThumb(mediaId)
    await saveDraft() // без окремої кнопки «Зберегти чернетку» (мокап Workshop) — чернетка зберігається автоматично
  }
  catch (err) {
    error.value = apiErrorOf(err).message
  }
  finally {
    uploading.value = false
  }
}

async function removeFile(i: number) {
  files.value.splice(i, 1)
  await saveDraft()
}

async function rateMentor(n: number) { if (!w.value?.current) return; try { await api(`/learning/workshops/${w.value.current.id}/rate-mentor`, { method: 'POST', body: { rating: n } }); w.value.current.mentorRating = n } catch (err) { error.value = apiErrorOf(err).message } }
async function saveDraft() {
  await api(`/learning/workshops/${workshopId}/draft`, { method: 'POST', body: { text: text.value, files: files.value, enrollmentId, lessonId } })
}

async function submit() {
  busy.value = true
  error.value = ''
  try {
    await api(`/learning/workshops/${workshopId}/submit`, { method: 'POST', body: { text: text.value, files: files.value, enrollmentId, lessonId, device: window.innerWidth < 768 ? 'mobile' : 'desktop' } })
    await load()
  }
  catch (err) {
    error.value = apiErrorOf(err).message
  }
  finally {
    busy.value = false
  }
}

async function sendComment() {
  if (!w.value?.current || !comment.value.trim()) return
  await api(`/review/submissions/${w.value.current.id}/comments`, { method: 'POST', body: { body: comment.value } })
  comment.value = ''
  await load()
}

const backTo = computed(() => enrollmentId ? `/learn/${enrollmentId}` : '/learn')
const fmt = (d: string | null) => d ? formatDateTime(new Date(d), { day: 'numeric', month: 'short', hour: '2-digit', minute: '2-digit' }) : ''
</script>

<template>
  <div class="ws">
    <StillHereDialog :open="stillHere" @confirm="time.confirmStillHere()" />
    <header class="top">
      <NuxtLink :to="backTo" class="close">✕</NuxtLink>
      <div class="title">{{ w?.title }}</div>
    </header>

    <main v-if="w" class="body">
      <p v-if="error" class="error">{{ error }}</p>

      <!-- Статус текущей сдачи -->
      <div v-if="w.current?.status === 'submitted' || w.current?.status === 'in_review'" class="status sun">
        <b>{{ t('workshop.onReview') }}</b>
        <span>{{ t('workshop.reviewBy', { at: fmt(w.current.slaDueAt) }) }}</span>
      </div>
      <div v-else-if="w.current?.status === 'rework'" class="status coral">
        <b>{{ t('workshop.rework') }}</b>
        <p>{{ w.current.reviewComment }}</p>
        <ul v-if="w.current.criteriaResults" class="crit-results">
          <li v-for="r in w.current.criteriaResults" :key="r.criterionId" :class="r.passed ? 'ok' : 'bad'">
            {{ r.passed ? '✓' : '✕' }} {{ w.criteria.find(c => c.id === r.criterionId)?.text }}<span v-if="r.comment"> — {{ r.comment }}</span>
          </li>
        </ul>
      </div>
      <div v-else-if="w.current?.status === 'accepted'" class="status teal">
        <b>{{ t('workshop.accepted') }}</b>
        <span v-if="w.current.score">{{ w.current.score }}%</span>
        <p v-if="w.current.reviewComment">{{ w.current.reviewComment }}</p>
        <div v-if="w.current.reviewerId" class="rate">
          <span>{{ w.current.mentorRating ? t('workshop.ratedMentor', { n: w.current.mentorRating }) : t('workshop.rateMentor') }}</span>
          <div v-if="!w.current.mentorRating" class="stars"><button v-for="n in 5" :key="n" class="star" :aria-label="String(n)" @click="rateMentor(n)">★</button></div>
        </div>
      </div>
      <div v-else-if="w.current?.status === 'rejected'" class="status coral">
        <b>{{ t('workshop.rejected') }}</b>
        <p>{{ w.current.reviewComment }}</p>
      </div>

      <!-- Задание -->
      <section class="block">
        <LessonBlocks :blocks="w.description" :blocks-state="{}" readonly />
      </section>

      <!-- Критерии — до начала (docs/13 §5.1); мокап Workshop: «Що перевіряє наставник», нумерованный список -->
      <section class="block">
        <h2>{{ t('workshop.criteriaLearner') }}</h2>
        <ol class="criteria numbered">
          <li v-for="c in w.criteria" :key="c.id">{{ c.text }}<span v-if="c.isCritical" class="crit"> · {{ t('workshop.critical') }}</span></li>
        </ol>
      </section>

      <!-- Форма сдачи -->
      <section v-if="editable" class="block form" @focusin="workingOnForm = true" @click="workingOnForm = true">
        <template v-if="w.submissionKinds.includes('text')">
          <label for="wtext" class="field-label">{{ t('workshop.commentLabel') }}</label>
          <textarea id="wtext" v-model="text" rows="6" :placeholder="t('workshop.textHint')" @blur="saveDraft" />
        </template>
        <p v-if="hint" class="hint">{{ hint }}</p>
        <div v-if="w.submissionKinds.some(k => k !== 'text')" class="files">
          <div v-for="(f, i) in files" :key="f.mediaId" class="tile" :class="{ photo: f.kind === 'photo' }">
            <img v-if="f.kind === 'photo' && thumbSrc(f.mediaId)" :src="thumbSrc(f.mediaId)" :alt="f.name">
            <span v-else class="tile-icon">{{ f.kind === 'photo' ? '🖼' : f.kind === 'video' ? '🎬' : '📎' }}</span>
            <span v-if="f.kind !== 'photo'" class="tile-name">{{ f.name }}</span>
            <button class="remove" :aria-label="t('common.delete')" @click="removeFile(i)">✕</button>
          </div>
          <label class="add-file tile">
            <input type="file" :accept="w.submissionKinds.includes('photo') ? 'image/*' : '*'" :capture="w.allowCameraOnly ? 'environment' : undefined" hidden @change="addFile">
            <span class="tile-icon" aria-hidden="true">📷</span>
            <span class="tile-name">{{ uploading ? t('blocks.uploading') : files.length ? t('workshop.morePhoto') : w.allowCameraOnly ? t('workshop.takePhoto') : t('workshop.addFile') }}</span>
          </label>
        </div>
      </section>

      <!-- Комментарии тредом -->
      <section v-if="w.current && w.comments.length" class="block">
        <h2>{{ t('workshop.comments') }}</h2>
        <div v-for="c in w.comments" :key="c.id" class="comment">
          <b>{{ c.authorName }}</b> <span class="sub">{{ fmt(c.createdAt) }}</span>
          <p>{{ c.body }}</p>
        </div>
      </section>
      <div v-if="w.current && !editable" class="comment-form">
        <input v-model="comment" :placeholder="t('workshop.commentHint')" @keyup.enter="sendComment">
        <button class="mini" @click="sendComment">→</button>
      </div>

      <!-- История -->
      <details v-if="w.history.length > 1" class="block">
        <summary>{{ t('workshop.history', { n: w.history.length }) }}</summary>
        <ul class="history">
          <li v-for="h in w.history" :key="h.attemptNo">#{{ h.attemptNo }} · {{ t(`workshop.status.${h.status}`) }} · {{ fmt(h.submittedAt) }}</li>
        </ul>
      </details>
    </main>

    <footer v-if="w && editable" class="bottom">
      <button class="primary" :disabled="!canSubmit || busy || uploading" @click="submit">{{ t('workshop.submit') }}</button>
    </footer>
  </div>
</template>

<style scoped>
.ws { min-height: 100dvh; display: flex; flex-direction: column; background: var(--color-bg); font-family: var(--font-family); color: var(--color-ink); }
.top { display: flex; align-items: center; gap: var(--space-3); padding: var(--space-3) var(--space-4); background: var(--color-bg-soft); border-bottom: 1px solid var(--color-bg-line); position: sticky; top: 0; }
.close { width: 36px; height: 36px; display: grid; place-items: center; border-radius: var(--radius-pill); background: var(--color-bg); color: var(--color-ink); text-decoration: none; font-weight: 800; }
.title { font-weight: 800; }
.body { flex: 1; padding: var(--space-4); padding-bottom: 100px; max-width: 720px; width: 100%; margin: 0 auto; box-sizing: border-box; display: grid; gap: var(--space-4); align-content: start; }
h2 { margin: 0 0 var(--space-2); font-size: var(--font-size-body-s); color: var(--color-ink-faint); text-transform: uppercase; letter-spacing: 0.04em; }
.block { display: grid; gap: var(--space-2); }
.status { border-radius: var(--radius-m); padding: var(--space-3) var(--space-4); display: grid; gap: var(--space-1); }
.status p { margin: 0; }
.status.sun { background: var(--color-sun); color: var(--color-sun-ink); }
.status.coral { background: var(--color-coral); color: var(--color-coral-deep); }
.status.teal { background: var(--color-teal); color: var(--color-teal-deep); }
.crit-results { margin: 0; padding-left: var(--space-4); font-size: var(--font-size-body-s); }
.criteria { margin: 0; padding-left: var(--space-5); display: grid; gap: var(--space-1); }
.criteria.numbered { list-style: none; padding-left: 0; counter-reset: crit; }
.criteria.numbered li { display: flex; gap: var(--space-2); counter-increment: crit; }
.criteria.numbered li::before { content: counter(crit); color: var(--color-teal-ink); font-weight: 900; flex: none; }
.crit { color: var(--color-coral-ink); font-size: var(--font-size-body-s); font-weight: 700; }
textarea, input { font: inherit; border: 2px solid var(--color-bg-line); border-radius: var(--radius-m); padding: var(--space-3); background: var(--color-bg-soft); color: var(--color-ink); width: 100%; box-sizing: border-box; }
.hint { margin: 0; font-size: var(--font-size-body-s); color: var(--color-ink-muted); }
.field-label { font-size: var(--font-size-body-s); font-weight: 800; }
.files { display: flex; gap: var(--space-2); flex-wrap: wrap; }
.tile { position: relative; width: 104px; height: 104px; border-radius: var(--radius-l); flex: none; display: flex; flex-direction: column; align-items: center; justify-content: center; gap: var(--space-1); overflow: hidden; }
.tile.photo { background: var(--color-teal); }
.tile.photo img { width: 100%; height: 100%; object-fit: cover; }
.tile .tile-icon { font-size: 26px; }
.tile .tile-name { font-size: var(--font-size-body-s); font-weight: 800; text-align: center; padding: 0 var(--space-1); word-break: break-word; }
.tile .remove { position: absolute; top: 4px; right: 4px; font: inherit; border: none; background: var(--color-bg-soft); color: var(--color-ink); border-radius: var(--radius-pill); width: 28px; height: 28px; cursor: pointer; }
.add-file { border: 2px dashed var(--color-bg-line); background: var(--color-bg-soft); cursor: pointer; color: var(--color-ink-muted); }
.mini { font: inherit; border: 1px solid var(--color-bg-line); background: var(--color-bg); border-radius: var(--radius-pill); width: 32px; height: 32px; cursor: pointer; flex: none; }
.comment { background: var(--color-bg-soft); border-radius: var(--radius-s); padding: var(--space-2) var(--space-3); }
.comment p { margin: var(--space-1) 0 0; }
.comment-form { display: flex; gap: var(--space-2); }
.history { margin: var(--space-2) 0 0; padding-left: var(--space-4); font-size: var(--font-size-body-s); color: var(--color-ink-muted); }
summary { cursor: pointer; font-weight: 700; }
.sub { font-size: var(--font-size-body-s); color: var(--color-ink-faint); }
.bottom { position: fixed; bottom: 0; left: 0; right: 0; background: var(--color-bg-soft); border-top: 1px solid var(--color-bg-line); padding: var(--space-3) var(--space-4) calc(var(--space-3) + env(safe-area-inset-bottom)); display: flex; gap: var(--space-2); justify-content: flex-end; }
.primary, .ghost { font: inherit; font-weight: 800; border: none; border-radius: var(--radius-pill); padding: var(--space-3) var(--space-5); cursor: pointer; }
.primary { background: var(--color-sun); color: var(--color-ink); }
.primary:disabled { opacity: 0.4; }
.ghost { background: transparent; border: 1px solid var(--color-bg-line); color: var(--color-ink-muted); }
.error { color: var(--color-coral-ink); }
.rate { display: flex; gap: var(--space-2); align-items: center; flex-wrap: wrap; margin-top: var(--space-2); }
.stars { display: flex; gap: 2px; }
.star { font: inherit; font-size: var(--font-size-title-l); border: none; background: transparent; cursor: pointer; color: var(--color-sun-ink); line-height: 1; min-width: 44px; min-height: 44px; }
</style>
