<script setup lang="ts">
/**
 * Картка кандидата — `/admin/candidates/:id` (docs/v2/28-recruiting-candidates.md §5.3).
 *
 * Чотири вкладки з п'яти: «Огляд», «Оцінки», «Коментарі», «Історія». «Проходження» і
 * «Співбесіда» приходять разом із призначеннями кандидату і авто-співбесідою (PR-14, PR-27).
 *
 * Усі рішення ухвалює сервер (CLAUDE.md п. 3): які переходи дозволені, чи маскувати контакти,
 * скільки днів у статусі — рахує `server/services/candidates.ts`. Екран лише показує.
 * Контакти приходять уже замаскованими (§7.10): роль без повного `candidate.view` фізично
 * не отримує номера, а не «не бачить його на екрані».
 */
import { CANDIDATE_REJECT_REASONS, CANDIDATE_SCORE_KINDS } from '#shared/enums'
import type { CandidateScoreKind, CandidateState } from '#shared/enums'
const { formatDate } = useFormat()

/**
 * Відкривають ті самі, кого пускає `GET /candidates/:id`: `candidate.view` — рекрутер, HR, керівник
 * точки; `review.queue` — наставник у межах призначеної йому перевірки (§2, критерій §13 к. 10).
 * Наставнику сервер віддає картку без контактів, резюме й коментарів: телефон і пошта — «—».
 */
definePageMeta({ layout: 'admin', middleware: 'admin-scope', requiredAnyScope: ['candidate.view', 'review.queue'] })

const { t } = useI18n()
const { api } = useApi()
const { hasScope } = useAuth()
const route = useRoute()
const id = route.params.id as string

interface Score {
  id: string
  kind: CandidateScoreKind
  valueNum: string | null
  scaleLevelId: string | null
  comment: string | null
  authorId: string | null
  isCurrent: boolean
  /** Оцінку ШІ дала заглушка, а не модель — не підстава для рішення (docs/v2/30 §7.2, Р-28.4). */
  aiStub: boolean
  createdAt: string
}
interface History {
  id: string
  event: 'status' | 'interview_declined' | 'interview_withdrawn'
  toStatusNameUk: string | null
  reasonCode: string | null
  reasonText: string | null
  alternative: string | null
  isAutomatic: boolean
  createdAt: string
}
interface Comment { id: string, authorName: string | null, body: string, visibility: string, createdAt: string }
interface Card {
  id: string
  fullName: string
  phone: string | null
  email: string | null
  state: CandidateState
  statusId: string | null
  statusNameUk: string | null
  statusColor: string | null
  source: string | null
  sourceDetail: string | null
  recruiterName: string | null
  accessUntil: string | null
  commLanguage: string
  resumeAssetId: string | null
  consentExpiresAt: string | null
  daysInStatus: number | null
  pdMasked: boolean
  createdAt: string
  scores: Score[]
  history: History[]
  comments: Comment[]
}
interface Status { id: string, nameUk: string, color: string, mapsTo: CandidateState, isActive: boolean }

type Tab = 'overview' | 'scores' | 'interview' | 'summary' | 'comments' | 'history'
/**
 * «Співбесіда» (docs/v2/30 §5.3) — лише з `interview.view`: оцінки ШІ, розшифровка, флаги.
 * «Підсумок» (§5.4, PR-29) — лише з `summary.view`: документ, його версії, надсилання кандидату.
 */
const TABS = computed<Tab[]>(() => [
  'overview', 'scores',
  ...(hasScope('interview.view') ? ['interview' as const] : []),
  ...(hasScope('summary.view') ? ['summary' as const] : []),
  // Коментарі рекрутерів — лише з `candidate.view` (§3.5): наставнику сервер їх не віддає, і
  // порожня вкладка казала б «коментарів немає» там, де вони є
  ...(hasScope('candidate.view') ? ['comments' as const] : []),
  'history',
])
const tab = ref<Tab>('overview')

const card = ref<Card | null>(null)
const statuses = ref<Status[]>([])
const error = ref('')
const notice = ref('')
const busy = ref('')

const moveTo = ref('')
/** Модальне вікно найму (§5.5): точка, посада, дата виходу — обовʼязкові. */
const hireOpen = ref(false)
const hireForm = reactive({ locationId: '', positionId: '', startDate: new Date().toISOString().slice(0, 10), mentorId: '', welcomeLetter: true, onboardingCourseIds: [] as string[] })
/**
 * Курси онбордингу (§5.5): предзаполняются из «посада → курси за замовчуванням» (docs/v2/39
 * П-24.3) — своих курсов должности и её группы. Рекрутер может снять галочку: назначаются
 * отмеченные, одним обычным назначением на курс.
 */
const onboarding = ref<{ courseId: string, title: string }[]>([])
watch(() => hireForm.positionId, async (positionId) => {
  onboarding.value = []
  hireForm.onboardingCourseIds = []
  if (!positionId) return
  try {
    const d = await api<{ effective: { courseId: string, title: string }[] }>(`/positions/${positionId}/default-courses`)
    onboarding.value = d.effective
    hireForm.onboardingCourseIds = d.effective.map(c => c.courseId)
  }
  catch { /* без курсов по умолчанию найм всё равно возможен */ }
})
const locations = ref<{ id: string, name: string }[]>([])
const positions = ref<{ id: string, name: string }[]>([])
const rejectOpen = ref(false)
const rejectForm = reactive({ reasonCode: 'skills', reasonText: '', notify: false })
const moveReason = ref('')
const scoreForm = reactive({ kind: 'manual' as CandidateScoreKind, valueNum: '', comment: '' })
const commentBody = ref('')

/** Види оцінок, які ставить людина: `ai` пише система авто-співбесіди (§3.4). */
const MANUAL_SCORE_KINDS = CANDIDATE_SCORE_KINDS.filter(k => k !== 'ai')
/** Причини відмови — закритий перелік (§6.2): звіт «Відмови за причинами» рахує саме їх. */
const REJECT_REASONS = CANDIDATE_REJECT_REASONS

async function load() {
  error.value = ''
  try {
    card.value = await api<Card>(`/candidates/${id}`)
    statuses.value = await api<Status[]>('/candidate-statuses', { query: { active: 'true' } }).catch(() => [])
    if (hasScope('candidate.hire') && !locations.value.length) {
      locations.value = await api<{ id: string, name: string }[]>('/refs/locations').catch(() => [])
      positions.value = await api<{ id: string, name: string }[]>('/refs/positions').catch(() => [])
    }
  }
  catch (err) { error.value = apiErrorOf(err).message }
}
onMounted(load)

/** Світлофор «Доступ до» (§5.3): прострочено — кораловий, менше 3 днів — сонячний. */
const accessTone = computed(() => {
  const until = card.value?.accessUntil
  if (!until) return ''
  const days = Math.ceil((new Date(`${until}T23:59:59`).getTime() - Date.now()) / 86_400_000)
  return days < 0 ? 'bad' : days <= 3 ? 'warn' : 'ok'
})

const currentScores = computed(() => (card.value?.scores ?? []).filter(s => s.isCurrent))

async function move() {
  if (!moveTo.value) return
  busy.value = 'move'
  error.value = ''
  try {
    await api(`/candidates/${id}/status`, {
      method: 'POST',
      body: { statusId: moveTo.value, ...(moveReason.value ? { reasonText: moveReason.value } : {}) },
    })
    notice.value = t('candidate.moved')
    moveTo.value = ''
    moveReason.value = ''
    await load()
  }
  catch (err) { error.value = apiErrorOf(err).message }
  finally { busy.value = '' }
}

async function addScore() {
  busy.value = 'score'
  error.value = ''
  try {
    await api(`/candidates/${id}/scores`, {
      method: 'POST',
      body: {
        kind: scoreForm.kind,
        ...(scoreForm.valueNum === '' ? {} : { valueNum: Number(scoreForm.valueNum) }),
        ...(scoreForm.comment ? { comment: scoreForm.comment } : {}),
      },
    })
    notice.value = t('candidate.scoreAdded')
    scoreForm.valueNum = ''
    scoreForm.comment = ''
    await load()
  }
  catch (err) { error.value = apiErrorOf(err).message }
  finally { busy.value = '' }
}

async function addComment() {
  busy.value = 'comment'
  error.value = ''
  try {
    await api(`/candidates/${id}/comments`, { method: 'POST', body: { body: commentBody.value, visibility: 'recruiters' } })
    commentBody.value = ''
    await load()
  }
  catch (err) { error.value = apiErrorOf(err).message }
  finally { busy.value = '' }
}

/**
 * Найм (§7.6): одна ручка, одна транзакція на сервері. Екран нічого не рахує — він показує,
 * що відповів сервер, у тому числі відмову за лімітом тарифу з продовженим доступом (§12.5).
 */
async function hire() {
  busy.value = 'hire'
  error.value = ''
  try {
    await api(`/candidates/${id}/hire`, {
      method: 'POST',
      body: {
        locationId: hireForm.locationId,
        positionId: hireForm.positionId,
        startDate: hireForm.startDate,
        ...(hireForm.mentorId ? { mentorId: hireForm.mentorId } : {}),
        welcomeLetter: hireForm.welcomeLetter,
        onboardingCourseIds: hireForm.onboardingCourseIds,
      },
    })
    hireOpen.value = false
    notice.value = t('candidate.hired')
    await load()
  }
  catch (err) { error.value = apiErrorOf(err).message }
  finally { busy.value = '' }
}

/** Відмова з причиною (§6.2). Автоматично система не відмовляє ніколи (§7.4). */
async function reject() {
  busy.value = 'reject'
  error.value = ''
  try {
    await api(`/candidates/${id}/reject`, { method: 'POST', body: { ...rejectForm, reasonText: rejectForm.reasonText || undefined } })
    rejectOpen.value = false
    notice.value = t('candidate.rejected')
    await load()
  }
  catch (err) { error.value = apiErrorOf(err).message }
  finally { busy.value = '' }
}

async function archive() {
  busy.value = 'archive'
  error.value = ''
  try {
    await api(`/candidates/${id}/archive`, { method: 'POST', body: {} })
    notice.value = t('candidate.archived')
    await load()
  }
  catch (err) { error.value = apiErrorOf(err).message }
  finally { busy.value = '' }
}

const dateOf = (v: string | null) => v ? formatDate(new Date(v), { day: '2-digit', month: '2-digit', year: 'numeric' }) : '—'
</script>

<template>
  <div>
    <PageHeader
      :title="card?.fullName ?? t('candidate.title')"
      :subtitle="t('candidate.hint')"
      :crumbs="[{ label: t('admin.nav.people'), to: '/admin/people' }, { label: t('candidate.title') }]"
    />

    <p v-if="error" class="error" role="alert">{{ error }}</p>
    <p v-if="notice" class="notice" role="status">{{ notice }}</p>

    <template v-if="card">
      <div class="head">
        <span :class="['pill', `tone-${card.statusColor ?? 'ink'}`]">{{ card.statusNameUk ?? '—' }}</span>
        <span class="sub">{{ t(`candidate.state.${card.state}`) }}</span>
        <span v-if="card.daysInStatus !== null" class="sub">{{ t('candidate.daysInStatus', { n: card.daysInStatus }) }}</span>
        <span v-if="card.recruiterName" class="sub">{{ t('candidate.recruiter') }}: {{ card.recruiterName }}</span>
      </div>

      <div class="filters">
        <button
          v-if="hasScope('candidate.hire') && card.state === 'active'" class="btn" type="button"
          @click="hireOpen = true"
        >
          {{ t('candidate.hire') }}
        </button>
        <button
          v-if="hasScope('candidate.decide') && card.state === 'active'" class="btn ghost" type="button"
          @click="rejectOpen = true"
        >
          {{ t('candidate.reject') }}
        </button>
        <button
          v-if="hasScope('candidate.decide') && card.state === 'active'" class="btn ghost" type="button"
          :disabled="busy === 'archive'" @click="archive"
        >
          {{ t('candidate.archive') }}
        </button>
      </div>

      <form v-if="hireOpen" class="panel form" @submit.prevent="hire">
        <h2 class="title">{{ t('candidate.hireTitle') }}</h2>
        <label>{{ t('candidate.location') }}
          <select v-model="hireForm.locationId" required>
            <option value="">—</option>
            <option v-for="l in locations" :key="l.id" :value="l.id">{{ l.name }}</option>
          </select>
        </label>
        <label>{{ t('candidate.position') }}
          <select v-model="hireForm.positionId" required>
            <option value="">—</option>
            <option v-for="pos in positions" :key="pos.id" :value="pos.id">{{ pos.name }}</option>
          </select>
        </label>
        <label>{{ t('candidate.startDate') }}
          <input v-model="hireForm.startDate" type="date" required>
        </label>
        <fieldset v-if="onboarding.length" class="onboarding">
          <legend>{{ t('candidate.onboardingCourses') }}</legend>
          <label v-for="c in onboarding" :key="c.courseId" class="row">
            <input v-model="hireForm.onboardingCourseIds" type="checkbox" :value="c.courseId">
            <span>{{ c.title }}</span>
          </label>
        </fieldset>
        <p v-else-if="hireForm.positionId" class="help">{{ t('candidate.noDefaultCourses') }}</p>
        <label class="row">
          <input v-model="hireForm.welcomeLetter" type="checkbox">
          <span>{{ t('candidate.welcomeLetter') }}</span>
        </label>
        <div class="row">
          <button class="btn" type="submit" :disabled="busy === 'hire'">{{ t('candidate.hire') }}</button>
          <button class="btn ghost" type="button" @click="hireOpen = false">{{ t('common.cancel') }}</button>
        </div>
      </form>

      <form v-if="rejectOpen" class="panel form" @submit.prevent="reject">
        <h2 class="title">{{ t('candidate.rejectTitle') }}</h2>
        <label>{{ t('candidate.reasonCode') }}
          <select v-model="rejectForm.reasonCode">
            <option v-for="r in REJECT_REASONS" :key="r" :value="r">{{ t(`candidate.reason.${r}`) }}</option>
          </select>
        </label>
        <label>{{ t('candidate.reason') }}
          <input v-model="rejectForm.reasonText" maxlength="500">
        </label>
        <label class="row">
          <input v-model="rejectForm.notify" type="checkbox">
          <span>{{ t('candidate.notifyRejected') }}</span>
        </label>
        <div class="row">
          <button class="btn" type="submit" :disabled="busy === 'reject'">{{ t('candidate.reject') }}</button>
          <button class="btn ghost" type="button" @click="rejectOpen = false">{{ t('common.cancel') }}</button>
        </div>
      </form>

      <div v-if="hasScope('candidate.decide')" class="filters">
        <label>{{ t('candidate.moveTo') }}
          <select v-model="moveTo">
            <option value="">—</option>
            <option v-for="s in statuses.filter(x => x.id !== card!.statusId)" :key="s.id" :value="s.id">{{ s.nameUk }}</option>
          </select>
        </label>
        <label>{{ t('candidate.reason') }}
          <input v-model="moveReason" maxlength="500">
        </label>
        <button class="btn" type="button" :disabled="!moveTo || busy === 'move'" @click="move">{{ t('candidate.move') }}</button>
      </div>

      <div class="tabs" role="tablist">
        <button
          v-for="tb in TABS" :key="tb" role="tab" :aria-selected="tab === tb"
          :class="['tab', { on: tab === tb }]" @click="tab = tb"
        >
          {{ t(`candidate.tabs.${tb}`) }}
        </button>
      </div>

      <section v-if="tab === 'overview'" class="panel card-grid">
        <dl>
          <dt>{{ t('candidate.phone') }}</dt>
          <dd>{{ card.phone ?? '—' }}</dd>
          <dt>{{ t('candidate.email') }}</dt>
          <dd>{{ card.email ?? '—' }}</dd>
          <dt>{{ t('candidate.source') }}</dt>
          <dd>{{ card.source ? t(`candidate.sourceOf.${card.source}`) : '—' }}<span v-if="card.sourceDetail" class="sub"> · {{ card.sourceDetail }}</span></dd>
          <dt>{{ t('candidate.accessUntil') }}</dt>
          <dd :class="accessTone">{{ dateOf(card.accessUntil) }}</dd>
          <dt>{{ t('candidate.commLanguage') }}</dt>
          <dd>{{ card.commLanguage }}</dd>
          <dt>{{ t('candidate.consentUntil') }}</dt>
          <dd>{{ dateOf(card.consentExpiresAt) }}</dd>
          <dt>{{ t('candidate.added') }}</dt>
          <dd>{{ dateOf(card.createdAt) }}</dd>
        </dl>
        <p v-if="card.pdMasked" class="sub">{{ t('candidate.masked') }}</p>
        <p class="sub">{{ t('candidate.accessHint') }}</p>
      </section>

      <section v-else-if="tab === 'scores'" class="panel">
        <ul class="list">
          <li v-for="s in currentScores" :key="s.id">
            <strong>{{ t(`candidate.scoreKind.${s.kind}`) }}</strong>: {{ s.valueNum ?? '—' }}
            <span class="sub">{{ dateOf(s.createdAt) }}</span>
            <div v-if="s.comment" class="sub">{{ s.comment }}</div>
            <!-- Оцінка ШІ — одне число поруч із людськими, а не замість них (docs/v2/30 §7.1) -->
            <div v-if="s.kind === 'ai'" class="sub">{{ t('interview.card.humanDecides') }}</div>
            <div v-if="s.kind === 'ai' && s.aiStub" class="stub" role="note">{{ t('interview.card.stub') }}</div>
          </li>
          <li v-if="currentScores.length === 0" class="sub">{{ t('candidate.noScores') }}</li>
        </ul>
        <form v-if="hasScope('candidate.edit') || hasScope('review.grade')" class="filters" @submit.prevent="addScore">
          <label>{{ t('candidate.scoreKindLabel') }}
            <select v-model="scoreForm.kind">
              <option v-for="k in MANUAL_SCORE_KINDS" :key="k" :value="k">{{ t(`candidate.scoreKind.${k}`) }}</option>
            </select>
          </label>
          <label>{{ t('candidate.scoreValue') }}
            <input v-model="scoreForm.valueNum" type="number" step="0.01" required>
          </label>
          <label>{{ t('candidate.scoreComment') }}
            <input v-model="scoreForm.comment" maxlength="2000">
          </label>
          <button class="btn" type="submit" :disabled="busy === 'score'">{{ t('common.add') }}</button>
        </form>
      </section>

      <section v-else-if="tab === 'comments'" class="panel">
        <ul class="list">
          <li v-for="c in card.comments" :key="c.id">
            <strong>{{ c.authorName ?? '—' }}</strong> <span class="sub">{{ dateOf(c.createdAt) }}</span>
            <div>{{ c.body }}</div>
          </li>
          <li v-if="card.comments.length === 0" class="sub">{{ t('candidate.noComments') }}</li>
        </ul>
        <form v-if="hasScope('candidate.edit')" class="filters" @submit.prevent="addComment">
          <label class="grow">{{ t('candidate.newComment') }}
            <input v-model="commentBody" maxlength="4000" required>
          </label>
          <button class="btn" type="submit" :disabled="busy === 'comment'">{{ t('common.add') }}</button>
        </form>
        <p class="sub">{{ t('candidate.commentsHint') }}</p>
      </section>

      <section v-else-if="tab === 'interview'" class="panel">
        <CandidateInterview :candidate-id="id" />
      </section>

      <section v-else-if="tab === 'summary'" class="panel">
        <CandidateSummary :candidate-id="id" />
      </section>

      <section v-else class="panel">
        <ul class="list">
          <li v-for="h in card.history" :key="h.id">
            <!-- Нейтральні рядки співбесіди (docs/v2/30 §7.5, §7.6): відмова від ШІ — не мінус -->
            <template v-if="h.event === 'interview_declined'">
              <strong>{{ t('interview.history.declined') }}</strong> <span class="sub">{{ dateOf(h.createdAt) }}</span>
              <div v-if="h.alternative" class="sub">{{ t(`interview.history.alternative.${h.alternative}`) }}</div>
            </template>
            <template v-else-if="h.event === 'interview_withdrawn'">
              <strong>{{ t('interview.history.withdrawn') }}</strong> <span class="sub">{{ dateOf(h.createdAt) }}</span>
            </template>
            <template v-else>
              <strong>{{ h.toStatusNameUk ?? '—' }}</strong> <span class="sub">{{ dateOf(h.createdAt) }}</span>
              <span v-if="h.isAutomatic" class="sub"> · {{ t('candidate.automatic') }}</span>
              <div v-if="h.reasonCode === 'interview_alternative'" class="sub">{{ t('interview.history.liveNeeded') }}<template v-if="h.reasonText"> · {{ h.reasonText }}</template></div>
              <div v-else-if="h.reasonText || h.reasonCode" class="sub">{{ h.reasonText ?? h.reasonCode }}</div>
            </template>
          </li>
          <li v-if="card.history.length === 0" class="sub">{{ t('candidate.noHistory') }}</li>
        </ul>
      </section>
    </template>
  </div>
</template>

<style scoped>
.form { display: grid; gap: var(--space-3); max-width: 32rem; margin-bottom: var(--space-3); }
.row { display: flex; gap: var(--space-2); align-items: center; }
.onboarding { border: 1px solid var(--color-bg-line); border-radius: var(--radius-s); padding: var(--space-2) var(--space-3); display: grid; gap: var(--space-1); margin: 0; }
.onboarding legend { font-weight: 700; padding: 0 var(--space-1); }
.title { margin: 0; }
.head { display: flex; flex-wrap: wrap; gap: var(--space-2); align-items: center; margin-bottom: var(--space-3); }
.filters { display: flex; flex-wrap: wrap; gap: var(--space-2); align-items: end; margin-bottom: var(--space-3); }
.grow { flex: 1 1 14rem; }
.tabs { display: flex; gap: var(--space-2); margin-bottom: var(--space-3); flex-wrap: wrap; }
.tab { font: inherit; font-weight: 700; border: 1px solid var(--color-bg-line); background: transparent; color: var(--color-ink-muted); border-radius: var(--radius-pill); padding: var(--space-1) var(--space-4); cursor: pointer; }
.tab.on { color: var(--color-ink); border-color: var(--color-ink); }
.card-grid dl { display: grid; grid-template-columns: max-content 1fr; gap: var(--space-1) var(--space-3); margin: 0; }
.card-grid dt { color: var(--color-ink-muted); }
.card-grid dd { margin: 0; }
.list { list-style: none; padding: 0; margin: 0 0 var(--space-3); display: grid; gap: var(--space-2); }
.tone-sun { background: var(--color-sun-soft); }
.tone-teal { background: var(--color-teal-soft); }
.tone-coral { background: var(--color-coral-soft); }
/* Светофор «Доступ до»: бирюза — норма, солнце — истекает, коралл — просрочено (CLAUDE.md п. 9).
   Берём «чернильные» варианты токенов: на бежевом фоне у них достаточный контраст. */
.ok { color: var(--color-teal-ink); }
.warn { color: var(--color-sun-ink); }
.bad { color: var(--color-coral-ink); }
.stub { margin-top: var(--space-1); color: var(--color-coral-ink); font-weight: 700; font-size: var(--font-size-body-s); }
@media (max-width: 480px) {
  .filters { flex-direction: column; align-items: stretch; }
  .card-grid dl { grid-template-columns: 1fr; }
}
</style>
