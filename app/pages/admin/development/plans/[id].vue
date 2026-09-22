<script setup lang="ts">
definePageMeta({ layout: 'admin', middleware: 'admin-scope', requiredScope: 'development.team' })
const { t } = useI18n()
const { api } = useApi()
const { hasScope } = useAuth()
const route = useRoute()
const id = route.params.id as string

interface Plan {
  id: string, userId: string, fullName: string, periodFrom: string, periodTo: string, ownerId: string | null,
  mentorId: string | null, mentorName: string | null, status: string, summary: string | null,
  approvedBy: string | null, approvedAt: string | null, closedAt: string | null, resultComment: string | null, createdAt: string,
}
interface Goal { id: string, title: string, kind: string, dueAt: string | null, statusCode: string, statusName: string, statusColor: string, isFinal: boolean, progressPct: number }
interface Card { plan: Plan, locationId: string | null, goals: Goal[], statuses: { code: string, name: string }[] }

const card = ref<Card | null>(null)
const error = ref('')
const notice = ref('')

async function load() {
  try { card.value = await api<Card>(`/development/plans/${id}`) }
  catch (err) { error.value = apiErrorOf(err).message }
}
onMounted(load)

const editing = ref(false)
const editForm = reactive({ summary: '', periodFrom: '', periodTo: '' })
function openEdit() {
  if (!card.value) return
  Object.assign(editForm, { summary: card.value.plan.summary ?? '', periodFrom: card.value.plan.periodFrom, periodTo: card.value.plan.periodTo })
  editing.value = true
}
async function saveEdit() {
  error.value = ''
  try { await api(`/development/plans/${id}`, { method: 'PATCH', body: editForm }); editing.value = false; await load() }
  catch (err) { error.value = apiErrorOf(err).message }
}

const people = ref<{ id: string, fullName: string }[]>([])
async function ensurePeople() { if (!people.value.length) people.value = await api<{ id: string, fullName: string }[]>('/people', { query: { limit: 300 } }).catch(() => []) }
const mentorEditing = ref(false)
const mentorId = ref('')
async function openMentor() { await ensurePeople(); mentorId.value = card.value?.plan.mentorId ?? ''; mentorEditing.value = true }
async function saveMentor() {
  error.value = ''
  try { await api(`/development/plans/${id}/mentor`, { method: 'POST', body: { mentorId: mentorId.value || null } }); mentorEditing.value = false; await load() }
  catch (err) { error.value = apiErrorOf(err).message }
}

async function transition(action: 'submit' | 'approve' | 'return' | 'review' | 'close', comment?: string) {
  error.value = ''; notice.value = ''
  try { await api(`/development/plans/${id}/transition`, { method: 'POST', body: { action, comment } }); notice.value = t('common.saved'); await load() }
  catch (err) { error.value = apiErrorOf(err).message }
}

// Крок плану — особиста ціль ІПР з planId; повний перегляд/зміна статусу — на картці цілі.
const addingGoal = ref(false)
const goalForm = reactive({ title: '', kind: 'result' as 'competency' | 'learning' | 'result' | 'project', dueAt: '' })
function openAddGoal() { Object.assign(goalForm, { title: '', kind: 'result', dueAt: '' }); addingGoal.value = true }
async function addGoal() {
  error.value = ''
  try {
    await api('/development/goals', { method: 'POST', body: { userId: card.value!.plan.userId, planId: id, title: goalForm.title, kind: goalForm.kind, dueAt: goalForm.dueAt } })
    addingGoal.value = false
    await load()
  }
  catch (err) { error.value = apiErrorOf(err).message }
}
</script>
<template>
  <div v-if="card">
    <NuxtLink to="/admin/development/plans" class="back">← {{ t('dev.backToPlans') }}</NuxtLink>
    <header class="head">
      <div>
        <div class="eyebrow">{{ card.plan.fullName }}</div>
        <h1>{{ card.plan.summary || t('dev.plan') }}</h1>
        <div class="sub">{{ card.plan.periodFrom }} — {{ card.plan.periodTo }}<template v-if="card.plan.mentorName"> · {{ t('dev.planMentor', { name: card.plan.mentorName }) }}</template></div>
      </div>
      <span :class="['badge', card.plan.status === 'active' ? 'teal' : card.plan.status === 'closed' ? 'muted' : 'sun']">{{ t(`dev.planAdminStatus.${card.plan.status}`) }}</span>
    </header>
    <p v-if="error" class="error" role="alert">{{ error }}</p>
    <p v-if="notice" class="notice">{{ notice }}</p>

    <div v-if="hasScope('development.team')" class="row actions-row">
      <button class="chip" @click="openEdit">{{ t('common.edit') }}</button>
      <button class="chip" @click="openMentor">{{ t('dev.mentorLabel') }}</button>
      <button v-if="card.plan.status === 'draft'" class="chip" @click="transition('submit')">{{ t('dev.submitPlan') }}</button>
      <button v-if="card.plan.status === 'on_approval'" class="chip" @click="transition('approve')">{{ t('dev.approvePlan') }}</button>
      <button v-if="card.plan.status === 'on_approval' || card.plan.status === 'review'" class="chip" @click="transition('return')">{{ t('dev.returnPlan') }}</button>
      <button v-if="card.plan.status === 'active'" class="chip" @click="transition('review')">{{ t('dev.toReview') }}</button>
      <button v-if="card.plan.status === 'review' || card.plan.status === 'active'" class="chip" @click="transition('close')">{{ t('dev.closePlan') }}</button>
    </div>

    <section class="card">
      <div class="row head2"><h2>{{ t('dev.planSteps') }}</h2><button v-if="hasScope('development.team')" class="chip" @click="openAddGoal">+ {{ t('dev.addGoal') }}</button></div>
      <p v-if="card.goals.length === 0" class="sub">{{ t('dev.noGoals') }}</p>
      <ul v-else class="list">
        <li v-for="g in card.goals" :key="g.id" class="goal-row">
          <NuxtLink :to="`/learn/development/goals/${g.id}`" class="link">{{ g.title }}</NuxtLink>
          <span class="sub">{{ t(`dev.kind.${g.kind}`) }}<template v-if="g.dueAt"> · {{ t('dev.due') }} {{ g.dueAt }}</template></span>
          <div class="bar"><div class="bar-fill" :style="{ width: `${g.progressPct}%` }" /></div>
          <span :class="['badge', g.statusColor]">{{ g.statusName }}</span>
        </li>
      </ul>
    </section>

    <div v-if="editing" class="overlay" @click.self="editing = false">
      <form class="modal" role="dialog" aria-modal="true" @submit.prevent="saveEdit">
        <h2>{{ t('common.edit') }}</h2>
        <label>{{ t('dev.planGoal') }}<input v-model="editForm.summary" class="field" maxlength="2000"></label>
        <div class="two">
          <label>{{ t('peopleReport.from') }}<input v-model="editForm.periodFrom" type="date" required class="field"></label>
          <label>{{ t('peopleReport.to') }}<input v-model="editForm.periodTo" type="date" required class="field"></label>
        </div>
        <div class="row2"><button type="button" class="chip" @click="editing = false">{{ t('common.cancel') }}</button><button type="submit" class="primary">{{ t('common.save') }}</button></div>
      </form>
    </div>

    <div v-if="mentorEditing" class="overlay" @click.self="mentorEditing = false">
      <form class="modal" role="dialog" aria-modal="true" @submit.prevent="saveMentor">
        <h2>{{ t('dev.mentorLabel') }}</h2>
        <select v-model="mentorId" class="field">
          <option value="">{{ t('dev.noMentor') }}</option>
          <option v-for="u in people" :key="u.id" :value="u.id">{{ u.fullName }}</option>
        </select>
        <div class="row2"><button type="button" class="chip" @click="mentorEditing = false">{{ t('common.cancel') }}</button><button type="submit" class="primary">{{ t('common.save') }}</button></div>
      </form>
    </div>

    <div v-if="addingGoal" class="overlay" @click.self="addingGoal = false">
      <form class="modal" role="dialog" aria-modal="true" @submit.prevent="addGoal">
        <h2>{{ t('dev.addGoal') }}</h2>
        <label>{{ t('dev.goalTitle') }}<input v-model="goalForm.title" required minlength="3" maxlength="200" class="field"></label>
        <label>{{ t('dev.kindCol') }}
          <select v-model="goalForm.kind" class="field">
            <option v-for="k in ['competency', 'learning', 'result', 'project']" :key="k" :value="k">{{ t(`dev.kind.${k}`) }}</option>
          </select>
        </label>
        <label>{{ t('dev.due') }}<input v-model="goalForm.dueAt" type="date" required class="field"></label>
        <div class="row2"><button type="button" class="chip" @click="addingGoal = false">{{ t('common.cancel') }}</button><button type="submit" class="primary" :disabled="goalForm.title.length < 3 || !goalForm.dueAt">{{ t('common.save') }}</button></div>
      </form>
    </div>
  </div>
  <p v-else-if="error" class="error">{{ error }}</p>
</template>
<style scoped>
.back { font-size: var(--font-size-body-s); color: var(--color-ink-muted); text-decoration: none; display: inline-block; margin-bottom: var(--space-3); }
.head { display: flex; align-items: flex-start; justify-content: space-between; gap: var(--space-3); margin-bottom: var(--space-3); flex-wrap: wrap; }
.head2 { justify-content: space-between; margin-bottom: var(--space-2); }
.eyebrow { font-size: var(--font-size-body-s); font-weight: 700; color: var(--color-ink-muted); }
h1 { margin: 2px 0 4px; font-weight: 900; }
h2 { margin: 0; font-weight: 800; }
.row { display: flex; gap: var(--space-2); align-items: center; flex-wrap: wrap; }
.actions-row { margin-bottom: var(--space-4); }
.row2 { display: flex; gap: var(--space-2); justify-content: flex-end; }
.card { background: var(--color-bg-soft); border-radius: var(--radius-m); padding: var(--space-4); }
.list { list-style: none; margin: 0; padding: 0; display: grid; gap: var(--space-2); }
.goal-row { display: flex; align-items: center; gap: var(--space-3); padding: var(--space-2) 0; border-bottom: 1px solid var(--color-bg-line-soft); flex-wrap: wrap; }
.link { color: var(--color-ink); font-weight: 700; }
.bar { height: 8px; background: var(--color-bg-line-soft); border-radius: var(--radius-pill); overflow: hidden; width: 100px; margin-left: auto; }
.bar-fill { height: 100%; background: var(--color-teal); border-radius: var(--radius-pill); }
.badge { font-size: var(--font-size-body-s); font-weight: 700; border-radius: var(--radius-pill); padding: 2px var(--space-3); background: var(--color-bg-line-soft); white-space: nowrap; }
.badge.teal { background: var(--color-teal); color: var(--color-teal-deep); }
.badge.coral { background: var(--color-coral); color: var(--color-coral-deep); }
.badge.sun { background: var(--color-sun); color: var(--color-sun-ink); }
.badge.muted { background: var(--color-bg-line-soft); color: var(--color-ink-muted); }
.sub { font-size: var(--font-size-body-s); color: var(--color-ink-faint); }
.error { color: var(--color-coral-ink); }
.notice { color: var(--color-teal-ink); }
.chip { font: inherit; font-size: var(--font-size-body-s); font-weight: 700; border: 1px solid var(--color-bg-line); background: transparent; color: var(--color-ink-muted); border-radius: var(--radius-pill); padding: var(--space-1) var(--space-3); cursor: pointer; }
.primary { font: inherit; font-weight: 800; border: none; background: var(--color-sun); color: var(--color-ink); border-radius: var(--radius-pill); padding: var(--space-2) var(--space-4); cursor: pointer; }
.primary:disabled { opacity: 0.5; }
.overlay { position: fixed; inset: 0; background: rgb(0 0 0 / 40%); display: grid; place-items: center; padding: var(--space-3); z-index: 20; overflow: auto; }
.modal { background: var(--color-bg-soft); border-radius: var(--radius-l); padding: var(--space-4); display: grid; gap: var(--space-2); width: min(480px, 100%); box-sizing: border-box; max-height: 100%; overflow: auto; }
.modal label { display: grid; gap: var(--space-1); font-size: var(--font-size-body-s); color: var(--color-ink-muted); }
.field { font: inherit; border: 1px solid var(--color-bg-line); border-radius: var(--radius-s); padding: var(--space-1) var(--space-2); background: var(--color-bg); color: var(--color-ink); min-width: 0; box-sizing: border-box; }
.two { display: grid; grid-template-columns: 1fr 1fr; gap: var(--space-2); }
</style>
