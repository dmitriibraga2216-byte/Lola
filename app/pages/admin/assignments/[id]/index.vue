<script setup lang="ts">
/**
 * Карточка назначения по мокапу TaskCard (docs/15 §14.2): шапка с метками, компетенциями
 * и автором, кнопка «Зберегти» (+ «Відхилити зміни», коли є незбережений вибір компетенцій);
 * четыре блока — Контент · Налаштування · Призначення · Результати.
 * Люди и снятие живут на экране аудитории; здесь — состояние, сводка и действия над назначением.
 */
const { formatShortDate } = useFormat()
definePageMeta({ layout: 'admin', middleware: 'admin-scope', requiredScope: 'assignment.create' })

const { t } = useI18n()
const { api } = useApi()
const { hasScope } = useAuth()
const route = useRoute()
const id = route.params.id as string

interface A {
  id: string, title: string, kind: string, subjectType: string, subjectId: string, status: string, isMandatory: boolean, dueMode: string, dueAt: string | null, dueDays: number | null,
  autoSync: boolean, createdAt: string, lastSyncAt: string | null, tags: string[], onLeaveCondition: string,
  params: Record<string, unknown>
  content: { id: string, title: string, summary: string | null } | null
  competencyIds: string[]
  assignedCount: number
  peopleTotal: number
  authorName?: string | null
  stats: { assigned?: number, started?: number, completed?: number, overdue?: number }
  people: { fullName: string }[]
}
interface Competency { id: string, name: string }

const a = ref<A | null>(null)
const competencies = ref<Competency[]>([])
const allCompetencies = ref<Competency[]>([])
const pickOpen = ref(false)
const picked = ref<string[]>([])
const error = ref('')
const notice = ref('')

async function load() {
  try {
    const [card, comps] = await Promise.all([api<A>(`/tasks/${id}`), api<Competency[]>(`/tasks/${id}/competencies`)])
    a.value = card
    competencies.value = comps
    picked.value = comps.map(c => c.id)
  }
  catch (err) {
    error.value = apiErrorOf(err).message
  }
}
onMounted(load)

/**
 * Заголовок картки за мокапом TaskCard і docs/15 §14.2 завжди має «Зберегти» (сонячна дія)
 * і, за потреби, «Відхилити зміни» — так само, як у `params.vue`. На цьому екрані єдине
 * редаговане в шапці — вибір компетенцій, тож «незбережене» = вибір відрізняється від
 * збереженого набору.
 */
const dirty = computed(() => {
  if (!a.value) return false
  const saved = competencies.value.map(c => c.id).slice().sort()
  const next = picked.value.slice().sort()
  return saved.length !== next.length || saved.some((v, i) => v !== next[i])
})

async function openPick() {
  try {
    if (allCompetencies.value.length === 0) allCompetencies.value = await api<Competency[]>('/competencies')
    pickOpen.value = true
  }
  catch (err) { error.value = apiErrorOf(err).message }
}
/** Скасовує невибрані/вибрані компетенції назад до збереженого набору (кнопка «Відхилити зміни» та закриття без збереження). */
function discardCompetencies() {
  picked.value = competencies.value.map(c => c.id)
  pickOpen.value = false
}
async function saveCompetencies() {
  try {
    await api(`/tasks/${id}/competencies`, { method: 'PUT', body: { competencyIds: picked.value } })
    pickOpen.value = false
    notice.value = t('assign.card.competenciesSaved')
    await load()
  }
  catch (err) { error.value = apiErrorOf(err).message }
}

async function setStatus(status: string) {
  try { await api(`/tasks/${id}`, { method: 'PATCH', body: { status } }); await load() }
  catch (err) { error.value = apiErrorOf(err).message }
}
async function remind() { try { const r = await api<{ reminded: number }>(`/assignments/${id}/remind`, { method: 'POST' }); notice.value = t('assign.reminded', { n: r.reminded }) } catch (err) { error.value = apiErrorOf(err).message } }
async function archive() { if (!confirm(t('assign.archiveConfirm'))) return; try { await api(`/assignments/${id}/archive`, { method: 'POST' }); await load() } catch (err) { error.value = apiErrorOf(err).message } }
async function cancel() {
  const reason = prompt(t('assign.cancelReason'))
  if (!reason || reason.length < 3) return
  const started = a.value?.stats.started ?? 0
  const keepStarted = started === 0 || confirm(t('assign.cancelKeep', { n: started }))
  try {
    const r = await api<{ removed: number, cancelled: number }>(`/assignments/${id}/cancel`, { method: 'POST', body: { reason, keepStarted } })
    notice.value = t('assign.cancelled', { removed: r.removed, cancelled: r.cancelled })
    await load()
  }
  catch (err) { error.value = apiErrorOf(err).message }
}

/** Сводка блока «Налаштування» в свёрнутом виде: «Поріг 85%», «3 спроби», «Час необмежений». */
const summary = computed(() => {
  const p = a.value?.params ?? {}
  const out: string[] = []
  out.push(typeof p.passScore === 'number' ? t('assign.card.threshold', { n: p.passScore }) : t('assign.card.thresholdDefault'))
  if (['test', 'complex_test', 'workshop'].includes(a.value?.subjectType ?? '')) {
    out.push(typeof p.attemptsAllowed === 'number' && p.attemptsAllowed > 0 ? t('assign.card.attempts', { n: p.attemptsAllowed }) : t('assign.card.attemptsUnlimited'))
  }
  out.push(typeof p.timeLimitSec === 'number' && p.timeLimitSec > 0 ? t('assign.card.time', { n: Math.round(p.timeLimitSec / 60) }) : t('assign.card.timeUnlimited'))
  return out
})
const contentSummary = computed(() => {
  const c = a.value?.content
  if (!c) return ''
  if (a.value?.subjectType === 'test' && c.summary) return `${c.title} · ${t('assign.card.questions', { n: Number(c.summary) })}`
  return c.title
})

/**
 * «Створити новий» у блоці «Контент» (docs/28 «Spec 15» долг, D-017): веде на форму створення
 * контенту саме того типу, що в цього призначення — шлях залежить від типу (`app/pages/admin/**`).
 * Створення й призначення розведені (`04` §4.9): нове призначення для щойно створеного контенту
 * заводиться окремо через «Обрати з існуючих» / «Додати призначення», як і для решти контенту.
 */
const CONTENT_CREATE_ROUTES: Record<string, string> = {
  course: '/admin/courses',
  training_program: '/admin/programs',
  resource: '/admin/resources/new',
  test: '/admin/quizzes',
  complex_test: '/admin/meetups/complex',
  workshop: '/admin/workshops',
  poll: '/admin/surveys',
  assessment: '/admin/assessment/forms/new',
  check_list: '/admin/checklists',
  meetup: '/admin/meetups',
  webinar: '/admin/meetups?kind=webinar',
  notice: '/admin/notices/new',
}
const createNewUrl = computed(() => a.value ? (CONTENT_CREATE_ROUTES[a.value.subjectType] ?? null) : null)
</script>

<template>
  <div>
    <PageHeader v-if="a" :title="a.title" :crumbs="[{ label: t('admin.section.learning') }, { label: t('admin.nav.assignments'), to: '/admin/assignments' }]">
      <template #actions>
        <button v-if="dirty" class="btn ghost small" @click="discardCompetencies">{{ t('assign.card.discard') }}</button>
        <button class="btn primary small" :disabled="!dirty" @click="saveCompetencies">{{ t('common.save') }}</button>
        <button v-if="a.status === 'active'" class="btn ghost small" @click="setStatus('paused')">{{ t('assign.pause') }}</button>
        <button v-if="a.status === 'paused' || a.status === 'draft'" class="btn ghost small" @click="setStatus('active')">{{ t('assign.resume') }}</button>
        <button v-if="a.status !== 'archived'" class="btn ghost small" @click="remind">{{ t('assign.remindAll') }}</button>
        <button v-if="hasScope('assignment.cancel') && a.status !== 'archived'" class="btn ghost small" @click="archive">{{ t('assign.archive') }}</button>
        <button v-if="hasScope('assignment.cancel') && a.status !== 'archived'" class="btn danger small" @click="cancel">{{ t('assign.cancel') }}</button>
      </template>
    </PageHeader>
    <p v-if="error" class="error-text">{{ error }}</p>
    <p v-if="notice" class="note teal">{{ notice }}</p>

    <template v-if="a">
      <div class="meta">
        <span v-for="tag in a.tags" :key="tag" class="chip outline">{{ tag }}</span>
        <span :class="['badge upper', a.status]">{{ t(`assign.state.${a.status}`) }}</span>
        <button class="chip" @click="openPick">{{ t('assign.card.competencies', { n: competencies.length }) }} · {{ t('assign.card.pickCompetencies') }}</button>
        <span class="muted">{{ a.authorName ? t('assign.card.author', { name: a.authorName }) : t('assign.card.noAuthor') }}</span>
      </div>

      <div class="blocks">
        <!-- 1. Контент -->
        <section class="card block">
          <div class="block-head"><b>{{ t(`contentType.${a.subjectType}`) }}</b><span class="muted">{{ t('assign.card.contentDesc') }}</span></div>
          <p class="block-body">{{ contentSummary || t('assign.card.noContent') }}</p>
          <div class="block-actions">
            <NuxtLink :to="`/admin/assignments/new?type=${a.subjectType}`" class="btn ghost small">{{ t('assign.card.pickExisting') }}</NuxtLink>
            <NuxtLink v-if="createNewUrl" :to="createNewUrl" class="btn ghost small">{{ t('assign.card.createNew') }}</NuxtLink>
          </div>
        </section>
        <!-- 2. Налаштування: открывается после выбора контента -->
        <section class="card block">
          <div class="block-head"><b>{{ t('assign.card.settings') }}</b><span class="muted">{{ t('assign.card.settingsDesc') }}</span></div>
          <div class="block-body chips"><span v-for="s in summary" :key="s" class="chip">{{ s }}</span></div>
          <div class="block-actions"><NuxtLink v-if="a.content" :to="`/admin/assignments/${id}/params`" class="btn ghost small">{{ t('assign.card.changeSettings') }}</NuxtLink></div>
        </section>
        <!-- 3. Призначення -->
        <section class="card block">
          <div class="block-head"><b>{{ t('assign.card.audience') }}</b><span class="muted">{{ t('assign.card.audienceDesc') }}</span></div>
          <p class="block-body"><b>{{ t('assign.card.assignedOf', { n: a.assignedCount, total: a.peopleTotal }) }}</b>
            <span class="sub"><span class="teal">{{ a.stats.completed ?? 0 }}</span> {{ t('assign.kpi.completed') }} · <span class="coral">{{ a.stats.overdue ?? 0 }}</span> {{ t('assign.kpi.overdue') }}</span>
          </p>
          <div class="block-actions"><NuxtLink :to="`/admin/assignments/${id}/audience`" class="btn primary small">{{ t('assign.card.assignBtn') }}</NuxtLink></div>
        </section>
        <!-- 4. Результати -->
        <section class="card block">
          <div class="block-head"><b>{{ t('assign.card.results') }}</b><span class="muted">{{ t('assign.card.resultsDesc') }}</span></div>
          <p class="block-body muted">{{ t('assign.autoSyncState', { on: a.autoSync ? '✓' : '—', at: a.lastSyncAt ? formatShortDate(new Date(a.lastSyncAt)) : '—' }) }}</p>
          <div class="block-actions"><NuxtLink :to="`/admin/reports?assignmentId=${id}`" class="btn ghost small">{{ t('assign.card.analyze') }}</NuxtLink></div>
        </section>
      </div>

      <div v-if="pickOpen" class="modal-back" role="dialog" aria-modal="true" @keydown.esc="discardCompetencies">
        <div class="modal card">
          <h2 class="panel-title">{{ t('assign.card.pickCompetencies') }}</h2>
          <p v-if="allCompetencies.length === 0" class="muted">{{ t('assign.card.noCompetencies') }}</p>
          <label v-for="c in allCompetencies" :key="c.id" class="check"><input v-model="picked" type="checkbox" :value="c.id"> {{ c.name }}</label>
          <div class="modal-actions">
            <button class="btn ghost small" @click="discardCompetencies">{{ t('common.cancel') }}</button>
            <button class="btn primary small" :disabled="!dirty" @click="saveCompetencies">{{ t('common.save') }}</button>
          </div>
        </div>
      </div>
    </template>
  </div>
</template>

<style scoped>
.meta { display: flex; flex-wrap: wrap; gap: var(--space-2); align-items: center; margin-bottom: var(--space-4); }
.blocks { display: grid; grid-template-columns: repeat(auto-fit, minmax(280px, 1fr)); gap: var(--space-3); }
.block { display: flex; flex-direction: column; gap: var(--space-3); }
.block-head { display: grid; gap: var(--space-1); }
.block-head b { font-size: var(--font-size-body); font-weight: 900; }
.block-body { margin: 0; flex: 1; }
.block-actions { display: flex; gap: var(--space-2); }
.teal { color: var(--color-teal-ink); font-weight: 700; }
.coral { color: var(--color-coral-ink); font-weight: 700; }
.check { display: flex; gap: var(--space-2); align-items: center; padding: var(--space-1) 0; }
.modal-back { position: fixed; inset: 0; background: rgb(12 15 20 / 0.4); display: grid; place-items: center; padding: var(--space-4); z-index: 20; }
.modal { width: min(480px, 100%); max-height: 80vh; overflow: auto; }
.modal-actions { display: flex; justify-content: flex-end; gap: var(--space-2); margin-top: var(--space-3); }
</style>
