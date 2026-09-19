<script setup lang="ts">
import type { ContentBlock } from '../../../shared/schemas/content'

definePageMeta({ layout: 'admin', middleware: 'admin-scope', requiredScope: 'review.queue' })

const { t } = useI18n()
const { api } = useApi()

interface Item { id: string, workshopTitle: string, fullName: string, attemptNo: number, status: string, submittedAt: string | null, hoursLeft: number | null, reviewerId: string | null, reworkCount: number, locationName: string | null }
interface Criterion { id: string, text: string, isCritical: boolean, weight: number }
interface Card {
  submission: { id: string, body: { text?: string }, files: { mediaId: string, name: string, kind: string }[], criteriaSnapshot: Criterion[], attemptNo: number, reworkCount: number, submittedAt: string | null }
  workshop: { title: string, description: ContentBlock[], passRule: { type: string }, allowRework: boolean, maxReworks: number } | null
  learner: { id: string, fullName: string }
  history: { attemptNo: number, status: string, reviewComment: string | null, criteriaResults: { criterionId: string, passed: boolean }[] | null }[]
  comments: { id: string, authorName: string, body: string, isInternal: boolean, createdAt: string }[]
}

const queue = ref<Item[]>([])
const answersCount = ref(0)
const card = ref<Card | null>(null)
const results = ref<Record<string, { passed: boolean, comment: string }>>({})
const comment = ref('')
const error = ref('')
const notice = ref('')
const busy = ref(false)
const mediaUrls = ref<Record<string, string>>({})

async function load() {
  try {
    queue.value = await api<Item[]>('/review/workshops')
    // Чипы очереди (мокап ReviewQueue): здачі практикумів · відповіді на перевірку · чек-листи
    answersCount.value = (await api<unknown[]>('/review/answers', { query: { checked: 'unchecked' } }).catch(() => [])).length
  }
  catch (err) {
    error.value = apiErrorOf(err).message
  }
}
onMounted(load)

async function open(item: Item) {
  error.value = ''
  try {
    await api(`/review/submissions/${item.id}/claim`, { method: 'POST' })
    card.value = await api<Card>(`/review/submissions/${item.id}`)
    results.value = Object.fromEntries(card.value.submission.criteriaSnapshot.map(c => [c.id, { passed: false, comment: '' }]))
    comment.value = ''
    mediaUrls.value = {}
    for (const f of card.value.submission.files) {
      api<{ urls: Record<string, string> }>(`/media/${f.mediaId}`).then(m => { mediaUrls.value[f.mediaId] = m.urls['768'] || m.urls.original! }).catch(() => {})
    }
  }
  catch (err) {
    error.value = apiErrorOf(err).message
    await load()
  }
}

const allPassed = computed(() => card.value?.submission.criteriaSnapshot.every(c => results.value[c.id]?.passed) ?? false)
const reworkAvailable = computed(() => card.value?.workshop?.allowRework && card.value.submission.reworkCount < (card.value.workshop.maxReworks ?? 0))

async function decide(decision: 'accepted' | 'rejected' | 'rework') {
  if (!card.value) return
  if (decision !== 'accepted' && comment.value.trim().length < 10) { error.value = t('review.commentRequired'); return }
  busy.value = true
  error.value = ''
  try {
    await api(`/review/submissions/${card.value.submission.id}/grade`, {
      method: 'POST',
      body: { decision, criteriaResults: Object.entries(results.value).map(([criterionId, r]) => ({ criterionId, passed: r.passed, comment: r.comment || undefined })), comment: comment.value || undefined },
    })
    notice.value = t(`workshop.decided.${decision}`)
    card.value = null
    await load()
    if (queue.value[0]) await open(queue.value[0])
  }
  catch (err) {
    error.value = apiErrorOf(err).message
  }
  finally {
    busy.value = false
  }
}

async function skip() {
  if (!card.value) return
  await api(`/review/submissions/${card.value.submission.id}/release`, { method: 'POST' })
  card.value = null
  await load()
}
</script>

<template>
  <div>
    <PageHeader :title="t('review.queueTitle')" :crumbs="[{ label: t('admin.section.learning') }, { label: t('review.queueTitle') }]" />
    <div v-if="!card" class="chips tabs" role="tablist">
      <span class="chip on" role="tab" aria-selected="true">{{ t('review.chipWorkshops') }} · {{ queue.length }}</span>
      <NuxtLink to="/admin/review" class="chip" role="tab">{{ t('review.chipAnswers') }} · {{ answersCount }}</NuxtLink>
      <NuxtLink to="/admin/checklists" class="chip" role="tab">{{ t('review.chipChecklists') }}</NuxtLink>
    </div>
    <p v-if="error" class="error">{{ error }}</p>
    <p v-if="notice" class="notice">{{ notice }}</p>

    <div v-if="!card" class="list">
      <article v-for="i in queue" :key="i.id" :class="['row', { late: (i.hoursLeft ?? 0) < 0 }]">
        <span class="avatar" aria-hidden="true">{{ i.fullName.split(' ').slice(0, 2).map(p => p[0] ?? '').join('').toUpperCase() }}</span>
        <span class="grow">
          <b>{{ i.fullName }}</b>
          <span class="sub">{{ i.locationName ? `${i.locationName} · ` : '' }}{{ t('workshop.cardTitle', { title: i.workshopTitle }) }}<template v-if="i.attemptNo > 1"> · {{ t('workshop.attemptN', { n: i.attemptNo }) }}</template></span>
          <span :class="['sla', { late: (i.hoursLeft ?? 0) < 0 }]">{{ i.hoursLeft === null ? '' : i.hoursLeft < 0 ? t('workshop.overdueH', { n: -i.hoursLeft }) : t('workshop.leftH', { n: i.hoursLeft }) }}</span>
        </span>
        <button class="btn primary small" @click="open(i)">{{ t('workshop.claim') }}</button>
      </article>
      <p v-if="queue.length === 0" class="empty">{{ t('review.empty') }}</p>
    </div>

    <div v-else class="split">
      <section class="pane">
        <h2>{{ card.learner.fullName }} · {{ card.workshop?.title }}</h2>
        <details class="task"><summary>{{ t('workshop.task') }}</summary><LessonBlocks :blocks="card.workshop?.description ?? []" :blocks-state="{}" readonly /></details>
        <p v-if="card.submission.body.text" class="answer">{{ card.submission.body.text }}</p>
        <div class="gallery">
          <template v-for="f in card.submission.files" :key="f.mediaId">
            <a v-if="mediaUrls[f.mediaId]" :href="mediaUrls[f.mediaId]" target="_blank" rel="noopener">
              <img v-if="f.kind === 'photo'" :src="mediaUrls[f.mediaId]" :alt="f.name">
              <span v-else class="file">📎 {{ f.name }}</span>
            </a>
          </template>
        </div>
        <div v-if="card.history.length" class="history">
          <h3>{{ t('workshop.history', { n: card.history.length + 1 }) }}</h3>
          <div v-for="h in card.history" :key="h.attemptNo" class="hist-item">#{{ h.attemptNo }} · {{ t(`workshop.status.${h.status}`) }}<span v-if="h.reviewComment"> — {{ h.reviewComment }}</span></div>
        </div>
      </section>

      <section class="pane decide">
        <h2>{{ t('workshop.criteria') }}</h2>
        <div v-for="c in card.submission.criteriaSnapshot" :key="c.id" class="crit">
          <label class="crit-row">
            <input v-model="results[c.id]!.passed" type="checkbox">
            <span>{{ c.text }}<span v-if="c.isCritical" class="critical"> · {{ t('workshop.critical') }}</span></span>
          </label>
          <input v-model="results[c.id]!.comment" class="crit-comment" :placeholder="t('workshop.critComment')">
        </div>
        <textarea v-model="comment" rows="3" :placeholder="t('review.commentHint')" />
        <div class="actions">
          <button class="ok" :disabled="busy || (card.workshop?.passRule.type === 'all_criteria' && !allPassed)" :title="!allPassed ? t('workshop.needAll') : ''" @click="decide('accepted')">{{ t('review.accept') }}</button>
          <button v-if="reworkAvailable" class="warn" :disabled="busy" @click="decide('rework')">{{ t('workshop.toRework') }}</button>
          <button class="bad" :disabled="busy" @click="decide('rejected')">{{ t('review.reject') }}</button>
          <button class="ghost" :disabled="busy" @click="skip">{{ t('workshop.skip') }}</button>
        </div>
      </section>
    </div>
  </div>
</template>

<style scoped>
.head { display: flex; align-items: baseline; gap: var(--space-3); margin-bottom: var(--space-4); }
h1 { margin: 0; font-weight: 900; }
h2 { margin: 0 0 var(--space-3); font-weight: 800; font-size: var(--font-size-title-l); }
h3 { margin: var(--space-3) 0 var(--space-1); font-size: var(--font-size-body-s); color: var(--color-ink-faint); text-transform: uppercase; }
.count { color: var(--color-ink-muted); }
.list { display: grid; gap: var(--space-2); }
.tabs { margin-bottom: var(--space-4); }
.row { display: flex; gap: var(--space-3); align-items: center; background: var(--color-bg-soft); border: 1px solid var(--color-bg-line-soft); border-radius: var(--radius-m); padding: var(--space-3) var(--space-4); color: var(--color-ink); }
.row.late { border-color: var(--color-coral); }
.grow { flex: 1; min-width: 0; }
.grow .sub { display: block; }
.sla { display: block; font-size: var(--font-size-body-s); color: var(--color-ink-muted); }
.sla.late { color: var(--color-coral-ink); font-weight: 700; }
.split { display: grid; grid-template-columns: 1fr 1fr; gap: var(--space-4); }
@media (max-width: 900px) { .split { grid-template-columns: 1fr; } }
.pane { background: var(--color-bg-soft); border-radius: var(--radius-l); padding: var(--space-4); display: grid; gap: var(--space-3); align-content: start; }
.task summary { cursor: pointer; font-weight: 700; color: var(--color-ink-muted); }
.answer { margin: 0; white-space: pre-wrap; background: var(--color-bg); border-radius: var(--radius-m); padding: var(--space-4); }
.gallery { display: flex; gap: var(--space-2); flex-wrap: wrap; }
.gallery img { width: 160px; height: 160px; object-fit: cover; border-radius: var(--radius-s); }
.file { display: inline-block; background: var(--color-bg); border-radius: var(--radius-s); padding: var(--space-2) var(--space-3); }
.hist-item { font-size: var(--font-size-body-s); color: var(--color-ink-muted); }
.crit { display: grid; gap: var(--space-1); }
.crit-row { display: flex; gap: var(--space-2); align-items: flex-start; font-weight: 700; }
.crit-row input { width: 20px; height: 20px; accent-color: var(--color-teal); flex: none; margin-top: 2px; }
.critical { color: var(--color-coral-ink); font-size: var(--font-size-body-s); }
.crit-comment, textarea { font: inherit; border: 1px solid var(--color-bg-line); border-radius: var(--radius-s); padding: var(--space-2) var(--space-3); background: var(--color-bg); color: var(--color-ink); width: 100%; box-sizing: border-box; }
.actions { display: flex; gap: var(--space-2); flex-wrap: wrap; }
.ok, .warn, .bad, .ghost { font: inherit; font-weight: 800; border: none; border-radius: var(--radius-pill); padding: var(--space-2) var(--space-4); cursor: pointer; }
.ok { background: var(--color-teal); color: var(--color-teal-deep); }
.ok:disabled { opacity: 0.4; cursor: not-allowed; }
.warn { background: var(--color-sun); color: var(--color-sun-ink); }
.bad { background: var(--color-coral); color: var(--color-coral-deep); }
.ghost { background: transparent; border: 1px solid var(--color-bg-line); color: var(--color-ink-muted); }
.sub { font-size: var(--font-size-body-s); color: var(--color-ink-faint); }
.empty { color: var(--color-ink-faint); padding: var(--space-7); text-align: center; }
.error { color: var(--color-coral-ink); }
.notice { color: var(--color-teal-ink); }
</style>
