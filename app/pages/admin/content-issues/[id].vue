<script setup lang="ts">
/**
 * Карточка жалобы — `/admin/content-issues/:id` (docs/v2/36 §5.4, форма разбора §6.2).
 *
 * Слева — что не так: элемент и версия, заявители с контекстом и скриншотами, журнал.
 * Справа — разбор: статус, ответственный, срок, «Вплив на результати» с кнопкой
 * «Перерахувати результати» — второй вход в ту же логику, что у «Перерахувати» отчёта по тесту
 * (П-12.4). Какие кнопки показать, решает сервер (`card.actions`): керівник точки видит
 * карточку без кнопок разбора, автор — без пересчёта баллов.
 */
import type { ContentIssueRescoreMode, ContentIssueCard, ContentIssueEventRow, RescorePreview, RescoreResult } from '#shared/schemas/contentIssues'
import type { ContentIssueAction } from '#shared/domain/contentIssues'
import type { ContentIssueResolution } from '#shared/enums'

definePageMeta({ layout: 'admin', middleware: 'admin-scope', requiredScope: 'content_issue.view' })

const { t } = useI18n()
const { api } = useApi()
const { formatShortDate, formatDateTime, formatNumber } = useFormat()
const route = useRoute()
const id = computed(() => String(route.params.id))

const card = ref<ContentIssueCard | null>(null)
const notFound = ref(false)
const error = ref('')
const notice = ref('')
const busy = ref(false)

type Panel = '' | 'fix' | 'reject' | 'defer' | 'assign' | 'rescore'
const panel = ref<Panel>('')
const form = reactive({
  resolution: '' as ContentIssueResolution | '',
  resolutionComment: '',
  internalNote: '',
  dueAt: '',
  affectsScoring: false,
  assignee: '',
  comment: '',
  commentInternal: false,
})
const people = ref<{ id: string, fullName: string }[]>([])

const rescoreMode = ref<ContentIssueRescoreMode>('recalc')
const rescoreReason = ref('')
const preview = ref<RescorePreview | null>(null)
const previewLoading = ref(false)
const rescoreResult = ref<RescoreResult | null>(null)

async function load() {
  error.value = ''
  try {
    card.value = await api<ContentIssueCard>(`/content-issues/${id.value}`)
    notFound.value = false
  }
  catch (err) {
    const e = apiErrorOf(err)
    if (e.code === 'not_found') notFound.value = true
    else error.value = e.message
  }
}
onMounted(load)

const can = (a: ContentIssueAction) => card.value?.actions.includes(a) ?? false
const RESCORE_MODES = ['recalc', 'void', 'skip'] as const
const isQuestion = computed(() => card.value?.targetType === 'question')
const confirmResolutions = computed<ContentIssueResolution[]>(() => isQuestion.value ? ['fixed', 'question_fixed', 'question_void'] : ['fixed'])
const rejectResolutions: ContentIssueResolution[] = ['not_an_error', 'duplicate', 'wont_fix', 'spam']
const today = new Date()
const minDue = new Date(today.getTime() + 86_400_000).toISOString().slice(0, 10)
const maxDue = new Date(today.getTime() + 180 * 86_400_000).toISOString().slice(0, 10)

function open(p: Panel) {
  panel.value = panel.value === p ? '' : p
  error.value = ''
  notice.value = ''
  Object.assign(form, { resolution: '', resolutionComment: '', internalNote: '', dueAt: '', affectsScoring: card.value?.affectsScoring ?? false, assignee: '' })
  if (p === 'fix') form.resolution = confirmResolutions.value[0]!
  if (p === 'reject') form.resolution = 'not_an_error'
  if (p === 'assign' && !people.value.length) {
    api<{ id: string, fullName: string }[]>('/people', { query: { limit: 300 } }).then((r) => { people.value = r }).catch(() => {})
  }
  if (p === 'rescore') openRescore()
}

/** Ответ сервера — всегда актуальная карточка; при конфликте её же кладём из `details.card` (§12). */
async function patch(body: Record<string, unknown>) {
  busy.value = true
  error.value = ''
  try {
    card.value = await api<ContentIssueCard>(`/content-issues/${id.value}`, { method: 'PATCH', body })
    panel.value = ''
    notice.value = t('contentIssues.saved')
  }
  catch (err) {
    const e = apiErrorOf(err)
    error.value = e.message
    const fresh = (e.details as { card?: ContentIssueCard } | undefined)?.card
    if (fresh) card.value = fresh
  }
  finally { busy.value = false }
}

const take = () => patch({ status: 'in_progress' })
const close = () => patch({ status: 'closed' })
const reopen = () => patch({ status: 'in_progress' })

function submitFix() {
  patch({
    status: 'fixed',
    resolution: form.resolution,
    ...(form.resolutionComment ? { resolutionComment: form.resolutionComment } : {}),
    ...(form.internalNote ? { internalNote: form.internalNote } : {}),
    ...(isQuestion.value || card.value?.targetType === 'quiz' ? { affectsScoring: form.affectsScoring || form.resolution !== 'fixed' } : {}),
  })
}
function submitReject() {
  patch({ status: 'rejected', resolution: form.resolution, resolutionComment: form.resolutionComment, ...(form.internalNote ? { internalNote: form.internalNote } : {}) })
}
function submitDefer() {
  patch({ status: 'deferred', dueAt: form.dueAt, ...(form.resolutionComment ? { resolutionComment: form.resolutionComment } : {}) })
}

async function submitAssign() {
  busy.value = true
  error.value = ''
  try {
    card.value = await api<ContentIssueCard>(`/content-issues/${id.value}/assign`, { method: 'POST', body: { userId: form.assignee } })
    panel.value = ''
    notice.value = t('contentIssues.saved')
  }
  catch (err) { error.value = apiErrorOf(err).message }
  finally { busy.value = false }
}

async function submitComment() {
  if (!form.comment.trim()) return
  busy.value = true
  error.value = ''
  try {
    card.value = await api<ContentIssueCard>(`/content-issues/${id.value}/comment`, { method: 'POST', body: { comment: form.comment, isInternal: form.commentInternal } })
    form.comment = ''
  }
  catch (err) { error.value = apiErrorOf(err).message }
  finally { busy.value = false }
}

async function loadPreview() {
  if (rescoreMode.value === 'skip') { preview.value = null; return }
  previewLoading.value = true
  try {
    preview.value = await api<RescorePreview>(`/content-issues/${id.value}/rescore-preview`, { query: { mode: rescoreMode.value } })
  }
  catch (err) { error.value = apiErrorOf(err).message }
  finally { previewLoading.value = false }
}
function openRescore() {
  rescoreResult.value = null
  rescoreReason.value = ''
  rescoreMode.value = card.value?.resolution === 'question_void' ? 'void' : 'recalc'
  loadPreview()
}
watch(rescoreMode, () => { if (panel.value === 'rescore') loadPreview() })

async function submitRescore() {
  busy.value = true
  error.value = ''
  try {
    rescoreResult.value = await api<RescoreResult>(`/content-issues/${id.value}/rescore`, { method: 'POST', body: { mode: rescoreMode.value, reason: rescoreReason.value } })
    await load()
  }
  catch (err) { error.value = apiErrorOf(err).message }
  finally { busy.value = false }
}

const dateOf = (v: string | null) => v ? formatShortDate(v) : '—'
const scoreOf = (v: number | null) => v === null ? '—' : `${formatNumber(v, { maximumFractionDigits: 2 })}%`

/** Строка журнала человеческим языком: переход, назначение, заметка, пересчёт. */
function eventText(e: ContentIssueEventRow): string {
  switch (e.kind) {
    case 'status_changed':
      return t('contentIssues.event.status_changed', {
        from: e.fromStatus ? t(`contentIssues.status.${e.fromStatus}`) : '—',
        to: e.toStatus ? t(`contentIssues.status.${e.toStatus}`) : '—',
      })
    case 'assigned':
      return t('contentIssues.event.assigned', { name: e.subjectName ?? '—' })
    case 'commented': {
      const flag = (e.payload as { affects_scoring?: boolean }).affects_scoring
      if (flag !== undefined) return t('contentIssues.event.flag', { value: t(flag ? 'contentIssues.event.yes' : 'contentIssues.event.no') })
      return t(e.isInternal ? 'contentIssues.card.internal' : 'contentIssues.event.commented')
    }
    default:
      return t(`contentIssues.event.${e.kind}`)
  }
}
</script>

<template>
  <div>
    <PageHeader
      :title="card?.title ?? t('contentIssues.title')"
      :crumbs="[{ label: t('contentIssues.title'), to: '/admin/content-issues' }, { label: card ? t(`issue.type.${card.issueType}`) : '…' }]"
    />

    <p v-if="notFound" class="note coral" role="alert">{{ t('contentIssues.card.notFound') }}</p>
    <p v-if="error" class="note coral" role="alert">{{ error }}</p>
    <p v-if="notice" class="note teal" role="status">{{ notice }}</p>

    <div v-if="card" class="layout">
      <div class="main">
        <section class="card">
          <h2 class="panel-title">{{ t('contentIssues.card.element') }}</h2>
          <p class="meta">
            <span class="badge">{{ t(`issue.type.${card.issueType}`) }}</span>
            <span class="badge muted">{{ t(`contentIssues.target.${card.targetType}`) }}</span>
            <span v-if="card.affectsScoring" class="badge sun">{{ t('contentIssues.affects') }}</span>
          </p>
          <p class="muted">
            {{ t('contentIssues.card.version', { v: card.contentVersion }) }}
            <template v-if="card.target.currentVersion !== null"> · {{ t('contentIssues.card.currentVersion', { v: card.target.currentVersion }) }}</template>
            <template v-if="card.blockId"> · {{ t('contentIssues.card.block', { id: card.blockId }) }}</template>
          </p>
          <p v-if="card.tracks.length" class="muted">{{ t('contentIssues.col.track') }}: {{ card.tracks.map(tr => tr.title).join(', ') }}</p>
          <p v-if="card.target.missing" class="note sun">{{ t('contentIssues.card.missing') }}</p>
          <NuxtLink v-if="card.target.editUrl" :to="card.target.editUrl" class="link">{{ t('contentIssues.card.openEditor') }}</NuxtLink>
        </section>

        <section class="card">
          <h2 class="panel-title">{{ t('contentIssues.card.reporters') }} · {{ t('contentIssues.card.reports', { n: card.reportsCount }) }}</h2>
          <ul class="list">
            <li v-for="r in card.reporters" :key="r.reportId">
              <div class="row-head">
                <strong>{{ r.user.fullName }}</strong>
                <span v-if="!r.user.active" class="badge muted">{{ t('contentIssues.inactive') }}</span>
                <span class="faint">{{ formatDateTime(r.createdAt) }}</span>
              </div>
              <p class="text">{{ r.comment ?? t('contentIssues.card.noComment') }}</p>
              <p class="faint small">
                <template v-if="r.context.playerPositionSec !== undefined">{{ t('contentIssues.card.context', { sec: r.context.playerPositionSec }) }} </template>
                <template v-if="r.context.scrollPct !== undefined">{{ t('contentIssues.card.scroll', { pct: r.context.scrollPct }) }} </template>
                <template v-if="r.attemptId">{{ t('contentIssues.card.attempt', { v: r.questionVersion ?? '—' }) }}</template>
              </p>
              <a v-if="r.screenshotMediaId" class="link" :href="`/api/v1/media/${r.screenshotMediaId}?redirect=1`" target="_blank" rel="noopener">{{ t('contentIssues.card.screenshot') }}</a>
            </li>
          </ul>
        </section>

        <section class="card">
          <h2 class="panel-title">{{ t('contentIssues.card.journal') }}</h2>
          <ol class="list journal">
            <li v-for="e in card.events" :key="e.id" :class="{ internal: e.isInternal }">
              <div class="row-head">
                <strong>{{ eventText(e) }}</strong>
                <span class="faint">{{ e.actor?.fullName ?? t('contentIssues.event.system') }} · {{ formatDateTime(e.createdAt) }}</span>
              </div>
              <p v-if="e.comment" class="text">{{ e.comment }}</p>
            </li>
          </ol>
          <form v-if="can('comment')" class="stack" @submit.prevent="submitComment">
            <label class="label" for="ci-comment">{{ t('contentIssues.form.comment') }}</label>
            <textarea id="ci-comment" v-model="form.comment" class="field" rows="2" maxlength="2000" />
            <label v-if="can('note')" class="check"><input v-model="form.commentInternal" type="checkbox"> {{ t('contentIssues.form.note') }} — {{ t('contentIssues.form.noteHint') }}</label>
            <button class="btn ghost small" type="submit" :disabled="busy || !form.comment.trim()">{{ t('contentIssues.action.comment') }}</button>
          </form>
        </section>
      </div>

      <aside class="side">
        <section class="card facts">
          <dl>
            <dt>{{ t('contentIssues.card.status') }}</dt>
            <dd><span :class="['badge', `st-${card.status}`]">{{ t(`contentIssues.status.${card.status}`) }}</span></dd>
            <template v-if="card.resolution">
              <dt>{{ t('contentIssues.card.resolution') }}</dt>
              <dd>{{ t(`contentIssues.resolution.${card.resolution}`) }}</dd>
            </template>
            <template v-if="card.resolutionComment">
              <dt>{{ t('contentIssues.card.reply') }}</dt>
              <dd>{{ card.resolutionComment }}</dd>
            </template>
            <dt>{{ t('contentIssues.card.assignee') }}</dt>
            <dd>
              {{ card.assignee?.fullName ?? t('contentIssues.unassigned') }}
              <span v-if="card.assignee && !card.assignee.active" class="faint">({{ t('contentIssues.inactive') }})</span>
            </dd>
            <dt>{{ t('contentIssues.card.due') }}</dt>
            <dd :class="{ 'due-late': card.overdue }">{{ dateOf(card.dueAt) }}<template v-if="card.overdue"> · {{ t('contentIssues.overdue') }}</template></dd>
            <dt>{{ t('contentIssues.card.severity') }}</dt>
            <dd>{{ t(`contentIssues.severity.${card.severity}`) }}</dd>
            <template v-if="card.affectsScoring || card.rescoreState !== 'none'">
              <dt>{{ t('contentIssues.card.rescore') }}</dt>
              <dd>{{ t(`contentIssues.rescoreState.${card.rescoreState}`) }}</dd>
            </template>
          </dl>
          <p v-if="card.actions.length === 1" class="faint small">{{ t('contentIssues.card.managerView') }}</p>
          <div class="actions">
            <button v-if="can('take')" class="btn primary" type="button" :disabled="busy" @click="take">{{ t('contentIssues.action.take') }}</button>
            <button v-if="can('fix')" class="btn primary" type="button" :aria-expanded="panel === 'fix'" @click="open('fix')">{{ t('contentIssues.action.fix') }}</button>
            <button v-if="can('reject')" class="btn ghost" type="button" :aria-expanded="panel === 'reject'" @click="open('reject')">{{ t('contentIssues.action.reject') }}</button>
            <button v-if="can('defer')" class="btn ghost" type="button" :aria-expanded="panel === 'defer'" @click="open('defer')">{{ t('contentIssues.action.defer') }}</button>
            <button v-if="can('close')" class="btn ghost" type="button" :disabled="busy" @click="close">{{ t('contentIssues.action.close') }}</button>
            <button v-if="can('reopen')" class="btn ghost" type="button" :disabled="busy" @click="reopen">{{ t('contentIssues.action.reopen') }}</button>
            <button v-if="can('assign')" class="btn ghost" type="button" :aria-expanded="panel === 'assign'" @click="open('assign')">{{ t('contentIssues.action.assign') }}</button>
          </div>

          <form v-if="panel === 'fix'" class="stack" @submit.prevent="submitFix">
            <fieldset>
              <legend class="label">{{ t('contentIssues.form.result') }}</legend>
              <label v-for="r in confirmResolutions" :key="r" class="check"><input v-model="form.resolution" type="radio" :value="r"> {{ t(`contentIssues.resolution.${r}`) }}</label>
            </fieldset>
            <label v-if="isQuestion || card.targetType === 'quiz'" class="check"><input v-model="form.affectsScoring" type="checkbox"> {{ t('contentIssues.affects') }}</label>
            <label class="label" for="ci-fix-comment">{{ t('contentIssues.form.commentForReporter') }}</label>
            <textarea id="ci-fix-comment" v-model="form.resolutionComment" class="field" rows="2" maxlength="1000" />
            <label class="label" for="ci-fix-note">{{ t('contentIssues.form.note') }}</label>
            <textarea id="ci-fix-note" v-model="form.internalNote" class="field" rows="2" maxlength="2000" />
            <p class="help">{{ t('contentIssues.form.noteHint') }}</p>
            <div class="actions">
              <button class="btn primary" type="submit" :disabled="busy">{{ t('contentIssues.action.save') }}</button>
              <button class="btn ghost" type="button" @click="panel = ''">{{ t('contentIssues.action.cancel') }}</button>
            </div>
          </form>

          <form v-if="panel === 'reject'" class="stack" @submit.prevent="submitReject">
            <fieldset>
              <legend class="label">{{ t('contentIssues.form.result') }}</legend>
              <label v-for="r in rejectResolutions" :key="r" class="check"><input v-model="form.resolution" type="radio" :value="r"> {{ t(`contentIssues.resolution.${r}`) }}</label>
            </fieldset>
            <label class="label" for="ci-rej-comment">{{ t('contentIssues.form.commentForReporter') }}</label>
            <textarea id="ci-rej-comment" v-model="form.resolutionComment" class="field" rows="3" minlength="10" maxlength="1000" required aria-describedby="ci-rej-hint" />
            <p id="ci-rej-hint" class="help">{{ t('contentIssues.form.commentHint') }}</p>
            <label class="label" for="ci-rej-note">{{ t('contentIssues.form.note') }}</label>
            <textarea id="ci-rej-note" v-model="form.internalNote" class="field" rows="2" maxlength="2000" />
            <div class="actions">
              <button class="btn primary" type="submit" :disabled="busy">{{ t('contentIssues.action.reject') }}</button>
              <button class="btn ghost" type="button" @click="panel = ''">{{ t('contentIssues.action.cancel') }}</button>
            </div>
          </form>

          <form v-if="panel === 'defer'" class="stack" @submit.prevent="submitDefer">
            <label class="label" for="ci-due">{{ t('contentIssues.form.dueDate') }}</label>
            <input id="ci-due" v-model="form.dueAt" class="field" type="date" :min="minDue" :max="maxDue" required aria-describedby="ci-due-hint">
            <p id="ci-due-hint" class="help">{{ t('contentIssues.form.dueHint') }}</p>
            <label class="label" for="ci-defer-comment">{{ t('contentIssues.form.comment') }}</label>
            <textarea id="ci-defer-comment" v-model="form.resolutionComment" class="field" rows="2" maxlength="1000" />
            <div class="actions">
              <button class="btn primary" type="submit" :disabled="busy">{{ t('contentIssues.action.defer') }}</button>
              <button class="btn ghost" type="button" @click="panel = ''">{{ t('contentIssues.action.cancel') }}</button>
            </div>
          </form>

          <form v-if="panel === 'assign'" class="stack" @submit.prevent="submitAssign">
            <label class="label" for="ci-assignee">{{ t('contentIssues.form.assignTo') }}</label>
            <select id="ci-assignee" v-model="form.assignee" class="field" required>
              <option value="" disabled>{{ t('contentIssues.form.choose') }}</option>
              <option v-for="p in people" :key="p.id" :value="p.id">{{ p.fullName }}</option>
            </select>
            <div class="actions">
              <button class="btn primary" type="submit" :disabled="busy || !form.assignee">{{ t('contentIssues.action.assign') }}</button>
              <button class="btn ghost" type="button" @click="panel = ''">{{ t('contentIssues.action.cancel') }}</button>
            </div>
          </form>
        </section>

        <section v-if="card.impact" class="card">
          <h2 class="panel-title">{{ t('contentIssues.card.impact') }}</h2>
          <p>{{ t('contentIssues.card.impactAttempts', { n: card.impact.attemptsTotal }) }}</p>
          <p>{{ t('contentIssues.card.impactFailed', { n: card.impact.failedOnQuestion }) }}</p>
          <button v-if="can('rescore')" class="btn primary" type="button" :aria-expanded="panel === 'rescore'" @click="open('rescore')">{{ t('contentIssues.action.rescore') }}</button>

          <form v-if="panel === 'rescore'" class="stack" @submit.prevent="submitRescore">
            <p class="help">{{ t('contentIssues.rescore.hint') }}</p>
            <fieldset>
              <legend class="label">{{ t('contentIssues.rescore.mode') }}</legend>
              <label v-for="m in RESCORE_MODES" :key="m" class="check"><input v-model="rescoreMode" type="radio" :value="m"> {{ t(`contentIssues.rescore.mode_${m}`) }}</label>
            </fieldset>
            <p v-if="previewLoading" class="muted" role="status">{{ t('contentIssues.rescore.previewLoading') }}</p>
            <div v-else-if="preview && rescoreMode !== 'skip'" class="note sun" role="status">
              <p>{{ t('contentIssues.rescore.preview', { changed: preview.attemptsChanged, total: preview.attemptsTotal, toPassed: preview.toPassed }) }}</p>
              <p v-if="preview.worseSkipped">{{ t('contentIssues.rescore.previewWorse', { worse: preview.worseSkipped, failed: preview.toFailedSkipped }) }}</p>
              <p v-if="preview.avgDelta !== null">{{ t('contentIssues.rescore.avgDelta', { delta: formatNumber(preview.avgDelta, { maximumFractionDigits: 1 }) }) }}</p>
            </div>
            <label class="label" for="ci-reason">{{ t('contentIssues.rescore.reason') }}</label>
            <textarea id="ci-reason" v-model="rescoreReason" class="field" rows="2" minlength="10" maxlength="1000" required aria-describedby="ci-reason-hint" />
            <p id="ci-reason-hint" class="help">{{ t('contentIssues.rescore.reasonHint') }}</p>
            <div class="actions">
              <button class="btn primary" type="submit" :disabled="busy || rescoreReason.trim().length < 10">{{ t('contentIssues.rescore.confirm') }}</button>
              <button class="btn ghost" type="button" @click="panel = ''">{{ t('contentIssues.action.cancel') }}</button>
            </div>
          </form>

          <div v-if="rescoreResult" class="note teal" role="status">
            <p v-if="rescoreResult.mode === 'skip'">{{ t('contentIssues.rescore.skipped') }}</p>
            <p v-else>{{ t('contentIssues.rescore.done', { n: rescoreResult.rescoredAttempts, toPassed: rescoreResult.toPassed }) }}</p>
            <template v-if="rescoreResult.worse.length">
              <p class="label">{{ t('contentIssues.rescore.worseTitle') }}</p>
              <ul>
                <li v-for="w in rescoreResult.worse" :key="w.attemptId">{{ w.fullName }}: {{ scoreOf(w.scoreBefore) }} → {{ scoreOf(w.scoreAfter) }}</li>
              </ul>
            </template>
          </div>
        </section>
      </aside>
    </div>
  </div>
</template>

<style scoped>
.layout { display: grid; grid-template-columns: minmax(0, 2fr) minmax(0, 1fr); gap: var(--space-4); align-items: start; }
.main, .side { display: grid; gap: var(--space-4); min-width: 0; }
.meta { display: flex; flex-wrap: wrap; gap: var(--space-2); margin: 0 0 var(--space-2); }
.list { list-style: none; margin: 0; padding: 0; display: grid; gap: var(--space-3); }
.list li { border-top: 1px solid var(--color-bg-line-soft); padding-top: var(--space-2); }
.list li:first-child { border-top: 0; padding-top: 0; }
.row-head { display: flex; flex-wrap: wrap; gap: var(--space-2); align-items: baseline; }
.text { margin: var(--space-1) 0; overflow-wrap: anywhere; }
.small { font-size: var(--font-size-body-s); margin: 0; }
.journal .internal { background: var(--color-sun-soft); border-radius: var(--radius-s); padding: var(--space-2) var(--space-3); }
.facts dl { display: grid; grid-template-columns: auto 1fr; gap: var(--space-1) var(--space-3); margin: 0 0 var(--space-3); }
.facts dt { color: var(--color-ink-muted); font-weight: 700; font-size: var(--font-size-body-s); }
.facts dd { margin: 0; overflow-wrap: anywhere; }
.actions { display: flex; flex-wrap: wrap; gap: var(--space-2); }
.stack { display: grid; gap: var(--space-2); margin-top: var(--space-3); }
fieldset { border: 0; margin: 0; padding: 0; display: grid; gap: var(--space-1); }
.check { display: flex; align-items: center; gap: var(--space-2); }
.st-new { background: var(--color-sun-soft); color: var(--color-sun-ink); }
.st-in_progress, .st-deferred { background: var(--color-sun); color: var(--color-sun-ink); }
.st-fixed, .st-closed { background: var(--color-teal); color: var(--color-teal-deep); }
.st-rejected { background: var(--color-bg-line-soft); color: var(--color-ink-muted); }
.due-late { color: var(--color-coral-ink); font-weight: 800; }
.note p { margin: 0 0 var(--space-1); }
@media (max-width: 900px) {
  .layout { grid-template-columns: minmax(0, 1fr); }
}
</style>
