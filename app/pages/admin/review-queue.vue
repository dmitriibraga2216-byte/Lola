<script setup lang="ts">
/**
 * «Мої перевірки» — единая очередь проверки (docs/v2/37 §5.1, §5.2; API `/review/queue`).
 *
 * Четыре таба — ось ответственности: «Мої» · «Делеговані мені» · «Делеговані мною» ·
 * «Завершені». Первые десять колонок — состав эталона в его порядке; сверх них «Перевіряючий»,
 * «Термін», «Ким делеговано» (только «Делеговані мені») и «Статус делегування» (только
 * «Делеговані мною»). Просроченные строки коралловые.
 *
 * Сама проверка (решение по работе) остаётся на своих экранах (`/admin/review-workshops`,
 * `/admin/review`): решение принимается над работой, а не над строкой очереди (В-15). Здесь —
 * карточка с цепочкой передач и действия над ответственностью: «Делегувати», «Відкликати
 * делегування», «Переназначити». Что из этого доступно — решает сервер (`can` в карточке).
 */
import { REVIEW_TASK_TYPES } from '#shared/enums'
import type { ReviewTaskType } from '#shared/enums'

definePageMeta({ layout: 'admin', middleware: 'admin-scope', requiredScope: 'review.queue' })

const { t } = useI18n()
const { api } = useApi()
const { hasScope } = useAuth()
const { formatShortDate, formatDateTime } = useFormat()

type Tab = 'mine' | 'delegated_in' | 'delegated_out' | 'done'
const TABS: Tab[] = ['mine', 'delegated_in', 'delegated_out', 'done']

interface Row {
  id: string
  taskType: ReviewTaskType
  fullName: string | null
  subjectKind: string
  locationName: string | null
  trackId: string | null
  trackTitle: string | null
  taskTitle: string | null
  attemptNo: number
  estimatedSeconds: number | null
  contentSeconds: number
  attemptSeconds: number
  completedAt: string | null
  status: string
  reviewerName: string | null
  slaDueAt: string | null
  hoursLeft: number | null
  overdue: boolean
  delegatedByName: string | null
  myDelegation: { id: string, state: string, toName: string | null, dueAt: string } | null
}
interface Counts { mine: number, mineOverdue: number, delegatedIn: number, delegatedOut: number }
interface Page { items: Row[], total: number, cursor: string | null, counts: Counts }
interface Card {
  item: { id: string, taskType: ReviewTaskType, taskTitle: string | null, status: string, attemptNo: number, slaDueAt: string | null, escalatedAt: string | null, escalatedToName: string | null, reviewerName: string | null, delegationDepth: number, locationName: string | null }
  subject: { fullName: string | null, kind: string }
  contactsHidden: boolean
  delegations: { id: string, depth: number, fromName: string | null, toName: string | null, reasonCode: string, reasonText: string | null, dueAt: string, state: string }[]
  conflict: 'self' | 'author' | null
  can: { delegate: boolean, revoke: string | null, reassign: boolean }
  work: { kind: 'workshop', text: string, criteria: { id: string, text: string }[], history: { attemptNo: number, status: string, reviewComment: string | null }[] }
    | { kind: 'quiz_open_answer', quizTitle: string | null, answer: { text?: string } | null, question: { criteria: string[] } | null, history: { attemptNo: number, status: string, score: number | null }[] }
    | null
}
interface Location { id: string, name: string }

const route = useRoute()
const tab = ref<Tab>(TABS.includes(route.query.tab as Tab) ? route.query.tab as Tab : 'mine')
const filters = reactive({ locationId: '', taskType: '' as ReviewTaskType | '', subjectKind: '' as '' | 'employee' | 'candidate', from: '', to: '', overdue: false })
const items = ref<Row[]>([])
const total = ref(0)
const cursor = ref<string | null>(null)
const counts = ref<Counts>({ mine: 0, mineOverdue: 0, delegatedIn: 0, delegatedOut: 0 })
const locations = ref<Location[]>([])
const loading = ref(true)
const loadError = ref(false)
const error = ref('')
const notice = ref('')
const selected = ref<string[]>([])

const card = ref<Card | null>(null)
const delegating = ref<{ ids: string[], slaDueAt: string | null } | null>(null)
const revoking = ref<{ id: string, toName: string | null, manager: boolean } | null>(null)
const revokeReason = ref('')
const reassigning = ref<Card | null>(null)
const reassignForm = reactive({ toUserId: '', reason: '' })
const reassignTargets = ref<{ id: string, fullName: string }[]>([])
const busy = ref(false)

function query(extra: Record<string, unknown> = {}) {
  return {
    tab: tab.value,
    ...(filters.locationId ? { locationId: filters.locationId } : {}),
    ...(filters.taskType ? { taskType: filters.taskType } : {}),
    ...(filters.subjectKind ? { subjectKind: filters.subjectKind } : {}),
    ...(filters.from ? { from: filters.from } : {}),
    ...(filters.to ? { to: filters.to } : {}),
    ...(filters.overdue ? { overdue: 'true' } : {}),
    limit: 50,
    ...extra,
  }
}

async function load() {
  loading.value = true
  loadError.value = false
  selected.value = []
  try {
    const page = await api<Page>('/review/queue', { query: query() })
    items.value = page.items
    total.value = page.total
    cursor.value = page.cursor
    counts.value = page.counts
  }
  catch {
    loadError.value = true
  }
  finally {
    loading.value = false
  }
}

async function more() {
  if (!cursor.value) return
  try {
    const page = await api<Page>('/review/queue', { query: query({ cursor: cursor.value }) })
    items.value.push(...page.items)
    cursor.value = page.cursor
  }
  catch (err) {
    error.value = apiErrorOf(err).message
  }
}

onMounted(async () => {
  locations.value = await api<Location[]>('/refs/locations').catch(() => [])
  await load()
})
watch([tab, () => ({ ...filters })], load, { deep: true })

const tabCount = (tb: Tab) => tb === 'mine' ? counts.value.mine : tb === 'delegated_in' ? counts.value.delegatedIn : tb === 'delegated_out' ? counts.value.delegatedOut : null
const selectable = computed(() => tab.value === 'mine' || tab.value === 'delegated_in')
const allSelected = computed(() => items.value.length > 0 && items.value.every(i => i.status === 'done' || selected.value.includes(i.id)))
function toggleAll() {
  selected.value = allSelected.value ? [] : items.value.filter(i => i.status !== 'done').map(i => i.id).slice(0, 25)
}
const minutes = (s: number | null) => (s ? t('reviewQueue.minutes', { n: Math.max(1, Math.round(s / 60)) }) : '—')
function dueText(r: Row) {
  if (r.status === 'done' || r.hoursLeft === null) return '—'
  return r.hoursLeft < 0 ? t('reviewQueue.overdueH', { n: -r.hoursLeft }) : t('reviewQueue.leftH', { n: r.hoursLeft })
}

async function openCard(id: string) {
  error.value = ''
  try {
    card.value = await api<Card>(`/review/items/${id}`)
  }
  catch (err) {
    error.value = apiErrorOf(err).message
  }
}

function startDelegate(ids: string[]) {
  const dues = items.value.filter(i => ids.includes(i.id)).map(i => i.slaDueAt).filter((d): d is string => !!d).sort()
  delegating.value = { ids, slaDueAt: card.value && ids.length === 1 ? card.value.item.slaDueAt : dues[0] ?? null }
}
async function afterDelegate(message: string) {
  delegating.value = null
  card.value = null
  notice.value = message
  await load()
}

function startRevoke(c: Card) {
  const link = c.delegations.find(d => d.id === c.can.revoke)
  revoking.value = { id: c.can.revoke!, toName: link?.toName ?? null, manager: hasScope('review.delegate.any') }
  revokeReason.value = ''
}
async function revoke() {
  if (!revoking.value) return
  busy.value = true
  error.value = ''
  try {
    await api(`/review/delegations/${revoking.value.id}/revoke`, { method: 'POST', body: revokeReason.value ? { reason: revokeReason.value } : {} })
    notice.value = t('reviewDelegate.revoked')
    revoking.value = null
    card.value = null
    await load()
  }
  catch (err) {
    error.value = apiErrorOf(err).message
  }
  finally {
    busy.value = false
  }
}

async function startReassign(c: Card) {
  reassigning.value = c
  reassignForm.toUserId = ''
  reassignForm.reason = ''
  reassignTargets.value = await api<{ id: string, fullName: string }[]>(`/review/items/${c.item.id}/delegate-targets`).catch(() => [])
}
async function reassign() {
  if (!reassigning.value) return
  busy.value = true
  error.value = ''
  try {
    await api(`/review/items/${reassigning.value.item.id}/reassign`, { method: 'POST', body: { ...reassignForm } })
    notice.value = t('reviewDelegate.reassigned')
    reassigning.value = null
    card.value = null
    await load()
  }
  catch (err) {
    error.value = apiErrorOf(err).message
  }
  finally {
    busy.value = false
  }
}

const reviewLink = (taskType: ReviewTaskType) => taskType === 'workshop' ? '/admin/review-workshops' : taskType === 'quiz_open_answer' ? '/admin/review' : null
</script>

<template>
  <div>
    <PageHeader :title="t('reviewQueue.title')" :subtitle="t('reviewQueue.hint')" :crumbs="[{ label: t('admin.section.learning') }, { label: t('reviewQueue.title') }]" />

    <div class="chips" role="tablist" :aria-label="t('reviewQueue.tabsLabel')">
      <button v-for="tb in TABS" :key="tb" role="tab" type="button" :aria-selected="tab === tb" :class="['chip', { on: tab === tb }]" @click="tab = tb">
        {{ t(`reviewQueue.tabs.${tb}`) }}<template v-if="tabCount(tb) !== null"> · {{ tabCount(tb) }}</template>
        <span v-if="tb === 'mine' && counts.mineOverdue" class="badge coral">{{ counts.mineOverdue }}</span>
      </button>
    </div>

    <div class="filters">
      <label>{{ t('reviewQueue.filter.location') }}
        <select v-model="filters.locationId" class="field small">
          <option value="">{{ t('reviewQueue.filter.allLocations') }}</option>
          <option v-for="l in locations" :key="l.id" :value="l.id">{{ l.name }}</option>
        </select>
      </label>
      <label>{{ t('reviewQueue.filter.taskType') }}
        <select v-model="filters.taskType" class="field small">
          <option value="">{{ t('reviewQueue.filter.allTaskTypes') }}</option>
          <option v-for="tt in REVIEW_TASK_TYPES" :key="tt" :value="tt">{{ t(`reviewQueue.taskType.${tt}`) }}</option>
        </select>
      </label>
      <label>{{ t('reviewQueue.filter.subjectKind') }}
        <select v-model="filters.subjectKind" class="field small">
          <option value="">{{ t('reviewQueue.filter.subjectAll') }}</option>
          <option value="employee">{{ t('reviewQueue.filter.subjectEmployee') }}</option>
          <option value="candidate">{{ t('reviewQueue.filter.subjectCandidate') }}</option>
        </select>
      </label>
      <label>{{ t('reviewQueue.filter.from') }}
        <input v-model="filters.from" type="date" class="field small">
      </label>
      <label>{{ t('reviewQueue.filter.to') }}
        <input v-model="filters.to" type="date" class="field small">
      </label>
      <label class="check">
        <input v-model="filters.overdue" type="checkbox">
        {{ t('reviewQueue.filter.overdue') }}
      </label>
    </div>

    <p v-if="error" class="error-text" role="alert">{{ error }}</p>
    <p v-if="notice" class="note teal" role="status">{{ notice }}</p>

    <div v-if="selectable && selected.length" class="bulk">
      <span>{{ t('reviewQueue.selected', { n: selected.length }) }}</span>
      <button v-if="hasScope('review.delegate')" class="btn primary small" type="button" @click="startDelegate(selected)">{{ t('reviewQueue.bulkDelegate') }}</button>
    </div>

    <div v-if="loadError" class="card state" role="alert">
      <p>{{ t('reviewQueue.loadError') }}</p>
      <button class="btn ghost small" type="button" @click="load">{{ t('reviewQueue.retry') }}</button>
    </div>
    <div v-else-if="loading" class="skeleton" :aria-label="t('reviewQueue.loading')" role="status">
      <div v-for="n in 10" :key="n" class="bar" />
    </div>
    <div v-else-if="!items.length" class="card state">{{ t(`reviewQueue.empty.${tab}`) }}</div>
    <div v-else class="table-wrap">
      <table class="table">
        <thead>
          <tr>
            <th v-if="selectable">
              <input type="checkbox" :checked="allSelected" :aria-label="t('reviewQueue.selectAll')" @change="toggleAll">
            </th>
            <th>{{ t('reviewQueue.col.person') }}</th>
            <th>{{ t('reviewQueue.col.location') }}</th>
            <th>{{ t('reviewQueue.col.track') }}</th>
            <th>{{ t('reviewQueue.col.taskType') }}</th>
            <th>{{ t('reviewQueue.col.task') }}</th>
            <th class="num">{{ t('reviewQueue.col.attempts') }}</th>
            <th class="num">{{ t('reviewQueue.col.estimated') }}</th>
            <th class="num">{{ t('reviewQueue.col.content') }}</th>
            <th class="num">{{ t('reviewQueue.col.attempt') }}</th>
            <th>{{ t('reviewQueue.col.completed') }}</th>
            <th>{{ t('reviewQueue.col.reviewer') }}</th>
            <th>{{ t('reviewQueue.col.due') }}</th>
            <th v-if="tab === 'delegated_in'">{{ t('reviewQueue.col.delegatedBy') }}</th>
            <th v-if="tab === 'delegated_out'">{{ t('reviewQueue.col.delegationState') }}</th>
            <th />
          </tr>
        </thead>
        <tbody>
          <tr v-for="r in items" :key="r.id" :class="{ late: r.overdue }">
            <td v-if="selectable">
              <input v-model="selected" type="checkbox" :value="r.id" :disabled="!selected.includes(r.id) && selected.length >= 25" :aria-label="t('reviewQueue.select')">
            </td>
            <td>
              <b>{{ r.fullName }}</b>
              <span v-if="r.subjectKind === 'candidate'" class="sub">{{ t('reviewQueue.card.candidate') }}</span>
            </td>
            <td>{{ r.locationName ?? '—' }}</td>
            <td>{{ r.trackTitle ?? '—' }}</td>
            <td>{{ t(`reviewQueue.taskType.${r.taskType}`) }}</td>
            <td>{{ r.taskTitle ?? '—' }}</td>
            <td class="num">{{ r.attemptNo }}</td>
            <td class="num">{{ minutes(r.estimatedSeconds) }}</td>
            <td class="num">{{ minutes(r.contentSeconds) }}</td>
            <td class="num">{{ minutes(r.attemptSeconds) }}</td>
            <td class="nowrap">{{ r.completedAt ? formatShortDate(r.completedAt) : '—' }}</td>
            <td>{{ r.reviewerName ?? t('reviewQueue.unassigned') }}</td>
            <td class="nowrap">
              <span :class="{ 'late-text': r.overdue }">{{ dueText(r) }}</span>
              <span class="sub">{{ t(`reviewQueue.status.${r.status}`) }}</span>
            </td>
            <td v-if="tab === 'delegated_in'">{{ r.delegatedByName ?? '—' }}</td>
            <td v-if="tab === 'delegated_out'">
              <template v-if="r.myDelegation">
                <span :class="['badge', r.myDelegation.state === 'active' ? 'sun' : r.myDelegation.state === 'resolved' ? 'teal' : 'muted']">{{ t(`reviewQueue.delegationState.${r.myDelegation.state}`) }}</span>
                <span class="sub">{{ r.myDelegation.toName }}</span>
              </template>
            </td>
            <td>
              <button class="btn ghost small" type="button" @click="openCard(r.id)">{{ t('reviewQueue.open') }}</button>
            </td>
          </tr>
        </tbody>
      </table>
      <p class="sub">{{ t('reviewQueue.shown', { n: items.length, total }) }}</p>
      <button v-if="cursor" class="btn ghost small" type="button" @click="more">{{ t('reviewQueue.loadMore') }}</button>
    </div>

    <!-- Карточка проверки (§5.2): ответ, критерии, история попыток, цепочка передач. -->
    <div v-if="card" class="overlay" @click.self="card = null" @keydown.esc="card = null">
      <section class="modal wide" role="dialog" aria-modal="true" aria-labelledby="card-title">
        <h2 id="card-title">{{ card.item.taskTitle ?? t(`reviewQueue.taskType.${card.item.taskType}`) }}</h2>
        <p class="sub">
          {{ card.subject.fullName }} · {{ card.subject.kind === 'candidate' ? t('reviewQueue.card.candidate') : t('reviewQueue.card.employee') }}
          <template v-if="card.item.locationName"> · {{ card.item.locationName }}</template>
          · {{ t(`reviewQueue.status.${card.item.status}`) }}
        </p>
        <p v-if="card.contactsHidden" class="note muted-note">{{ t('reviewQueue.card.contactsHidden') }}</p>
        <p v-if="card.conflict === 'self'" class="note coral">{{ t('reviewQueue.card.conflictSelf') }}</p>
        <p v-if="card.conflict === 'author'" class="note sun">{{ t('reviewQueue.card.conflictAuthor') }}</p>
        <p v-if="card.item.slaDueAt" class="sub">{{ t('reviewQueue.card.sla', { date: formatDateTime(card.item.slaDueAt) }) }}</p>
        <p v-if="card.item.escalatedAt && card.item.escalatedToName" class="note coral">{{ t('reviewQueue.card.escalatedTo', { name: card.item.escalatedToName }) }}</p>

        <template v-if="card.work?.kind === 'workshop'">
          <h3>{{ t('reviewQueue.card.answer') }}</h3>
          <p class="answer">{{ card.work.text }}</p>
          <h3>{{ t('reviewQueue.card.criteria') }}</h3>
          <ul><li v-for="c in card.work.criteria" :key="c.id">{{ c.text }}</li></ul>
          <h3>{{ t('reviewQueue.card.history') }}</h3>
          <p v-if="!card.work.history.length" class="sub">{{ t('reviewQueue.card.noHistory') }}</p>
          <ul v-else><li v-for="h in card.work.history" :key="h.attemptNo">{{ t('reviewQueue.card.attemptN', { n: h.attemptNo }) }} · {{ h.status }}<template v-if="h.reviewComment"> · {{ h.reviewComment }}</template></li></ul>
        </template>
        <template v-else-if="card.work?.kind === 'quiz_open_answer'">
          <h3>{{ t('reviewQueue.card.answer') }}</h3>
          <p class="answer">{{ card.work.answer?.text ?? '—' }}</p>
          <template v-if="card.work.question?.criteria.length">
            <h3>{{ t('reviewQueue.card.criteria') }}</h3>
            <ul><li v-for="c in card.work.question.criteria" :key="c">{{ c }}</li></ul>
          </template>
          <h3>{{ t('reviewQueue.card.history') }}</h3>
          <ul><li v-for="h in card.work.history" :key="h.attemptNo">{{ t('reviewQueue.card.attemptN', { n: h.attemptNo }) }} · {{ h.status }}<template v-if="h.score !== null"> · {{ h.score }}%</template></li></ul>
        </template>
        <p v-else class="sub">{{ t('reviewQueue.card.noWork') }}</p>

        <template v-if="card.delegations.length">
          <h3>{{ t('reviewQueue.card.chain') }}</h3>
          <ol class="chain">
            <li v-for="d in card.delegations" :key="d.id">
              {{ t('reviewQueue.card.chainLine', { from: d.fromName ?? '—', to: d.toName ?? '—' }) }}
              <span :class="['badge', d.state === 'active' ? 'sun' : d.state === 'resolved' ? 'teal' : 'muted']">{{ t(`reviewQueue.delegationState.${d.state}`) }}</span>
              <span class="sub">{{ t('reviewQueue.card.reasonLine', { reason: t(`reviewDelegate.reasons.${d.reasonCode}`) }) }}<template v-if="d.reasonText"> — {{ d.reasonText }}</template></span>
              <span class="sub">{{ t('reviewQueue.card.dueLine', { date: formatDateTime(d.dueAt) }) }}</span>
            </li>
          </ol>
        </template>

        <p v-if="card.item.delegationDepth >= 2 && card.item.status !== 'done'" class="sub">{{ t('reviewQueue.card.depthLimit') }}</p>

        <div class="modal-actions">
          <NuxtLink v-if="reviewLink(card.item.taskType) && card.item.status !== 'done'" :to="reviewLink(card.item.taskType)!" class="btn primary">{{ t('reviewQueue.card.goReview') }}</NuxtLink>
          <button v-if="card.can.delegate && hasScope('review.delegate')" class="btn ghost" type="button" @click="startDelegate([card.item.id])">{{ t('reviewQueue.delegate') }}</button>
          <button v-if="card.can.revoke" class="btn ghost" type="button" @click="startRevoke(card)">{{ t('reviewQueue.revoke') }}</button>
          <button v-if="card.can.reassign" class="btn ghost" type="button" @click="startReassign(card)">{{ t('reviewQueue.reassign') }}</button>
          <button class="btn ghost" type="button" @click="card = null">{{ t('reviewQueue.close') }}</button>
        </div>
      </section>
    </div>

    <ReviewDelegateDialog v-if="delegating" :item-ids="delegating.ids" :sla-due-at="delegating.slaDueAt" @close="delegating = null" @done="afterDelegate" />

    <div v-if="revoking" class="overlay" @click.self="revoking = null" @keydown.esc="revoking = null">
      <form class="modal" role="dialog" aria-modal="true" aria-labelledby="revoke-title" @submit.prevent="revoke">
        <h2 id="revoke-title">{{ t('reviewDelegate.revokeTitle') }}</h2>
        <p class="sub">{{ revoking.manager ? t('reviewDelegate.revokeConfirmManager', { name: revoking.toName ?? '' }) : t('reviewDelegate.revokeConfirm', { name: revoking.toName ?? '' }) }}</p>
        <label>{{ t('reviewDelegate.revokeReason') }}
          <input v-model="revokeReason" class="field" maxlength="500">
        </label>
        <p v-if="error" class="error-text" role="alert">{{ error }}</p>
        <div class="modal-actions">
          <button class="btn primary" type="submit" :disabled="busy">{{ t('reviewDelegate.revokeSubmit') }}</button>
          <button class="btn ghost" type="button" @click="revoking = null">{{ t('reviewDelegate.cancel') }}</button>
        </div>
      </form>
    </div>

    <div v-if="reassigning" class="overlay" @click.self="reassigning = null" @keydown.esc="reassigning = null">
      <form class="modal" role="dialog" aria-modal="true" aria-labelledby="reassign-title" @submit.prevent="reassign">
        <h2 id="reassign-title">{{ t('reviewDelegate.reassignTitle') }}</h2>
        <label>{{ t('reviewDelegate.to') }}
          <select v-model="reassignForm.toUserId" class="field" required>
            <option value="" disabled>{{ t('reviewDelegate.choose') }}</option>
            <option v-for="p in reassignTargets" :key="p.id" :value="p.id">{{ p.fullName }}</option>
          </select>
        </label>
        <label>{{ t('reviewDelegate.reassignReason') }}
          <input v-model="reassignForm.reason" class="field" minlength="3" maxlength="500" required>
        </label>
        <p v-if="error" class="error-text" role="alert">{{ error }}</p>
        <div class="modal-actions">
          <button class="btn primary" type="submit" :disabled="busy">{{ t('reviewDelegate.reassignSubmit') }}</button>
          <button class="btn ghost" type="button" @click="reassigning = null">{{ t('reviewDelegate.cancel') }}</button>
        </div>
      </form>
    </div>
  </div>
</template>

<style scoped>
.chips { margin-bottom: var(--space-3); }
.chip .badge { margin-left: var(--space-2); }
.filters { display: flex; flex-wrap: wrap; gap: var(--space-2); align-items: end; margin-bottom: var(--space-3); }
.filters label { display: grid; gap: var(--space-1); font-size: var(--font-size-body-s); color: var(--color-ink-muted); }
.filters .check { display: flex; align-items: center; gap: var(--space-2); color: var(--color-ink); }
.bulk { display: flex; flex-wrap: wrap; gap: var(--space-2); align-items: center; margin-bottom: var(--space-3); }
.state { display: grid; gap: var(--space-2); justify-items: start; color: var(--color-ink-muted); }
.skeleton { display: grid; gap: var(--space-2); }
.skeleton .bar { height: var(--space-6); border-radius: var(--radius-s); background: var(--color-bg-line-soft); }
tr.late td { background: var(--color-coral-soft); }
.late-text { color: var(--color-coral-ink); font-weight: 800; }
.nowrap { white-space: nowrap; }
.overlay { position: fixed; inset: 0; background: color-mix(in srgb, var(--color-ink) 45%, transparent); display: grid; place-items: center; padding: var(--space-3); z-index: 20; overflow: auto; }
.modal { background: var(--color-bg-soft); border-radius: var(--radius-l); padding: var(--space-4); display: grid; gap: var(--space-3); width: min(480px, 100%); box-sizing: border-box; }
.modal.wide { width: min(720px, 100%); max-height: 90dvh; overflow: auto; }
.modal h2 { margin: 0; font-weight: 900; }
.modal h3 { margin: 0; font-size: var(--font-size-body); }
.modal ul, .modal ol { margin: 0; padding-left: var(--space-5); display: grid; gap: var(--space-1); }
.modal label { display: grid; gap: var(--space-1); font-size: var(--font-size-body-s); color: var(--color-ink-muted); }
.modal .sub { color: var(--color-ink-muted); font-size: var(--font-size-body-s); margin: 0; display: block; }
.answer { white-space: pre-wrap; margin: 0; }
.chain li { display: grid; gap: var(--space-1); }
.muted-note { background: var(--color-bg-line-soft); color: var(--color-ink-muted); }
.modal-actions { display: flex; gap: var(--space-2); justify-content: flex-end; flex-wrap: wrap; }
@media (max-width: 480px) {
  .filters { flex-direction: column; align-items: stretch; }
}
</style>
