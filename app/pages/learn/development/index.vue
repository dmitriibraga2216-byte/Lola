<script setup lang="ts">
definePageMeta({ layout: 'learner' })
const { t } = useI18n()
const { api } = useApi()

interface GapItem { competencyId: string, name: string, requiredLevel: number, currentLevel: number, currentLevelLabel: string | null, maxLevel: number, gap: number, isCritical: boolean, source: string | null, validUntil: string | null, expiringSoon: boolean, whatToLearn: { id: string, title: string }[] }
interface Goal { id: string, title: string, kind: string, dueAt: string, statusCode: string, statusName: string, statusColor: string, isFinal: boolean, progressPct: number, approvedAt: string | null, returnComment: string | null }
interface Plan { id: string, periodFrom: string, periodTo: string, status: string, summary: string | null, mentorId: string | null, mentorName: string | null }
interface Me {
  gap: { position: { positionName: string } | null, profile: { id: string } | null, items: GapItem[], displayAs: 'label' | 'value' }
  plan: Plan | null, goals: Goal[]
  requests: { external: { id: string, title: string, status: string, format: string }[], career: { id: string, targetPosition: string, status: string }[] } | null
}
const data = ref<Me | null>(null)
const error = ref('')
const notice = ref('')
const tab = ref<'profile' | 'plan' | 'requests'>('profile')

const goalForm = ref({ title: '', kind: 'learning', dueAt: '', competencyId: '' })
const reqForm = ref({ title: '', provider: '', format: 'online', justification: '' })
const showGoalForm = ref(false)
const showReqForm = ref(false)

async function load() {
  try { data.value = await api<Me>('/development/me') }
  catch (err) { error.value = apiErrorOf(err).message }
}
onMounted(load)

async function createPlan() {
  const y = new Date().getFullYear()
  const from = new Date().toISOString().slice(0, 10)
  const to = `${y}-12-31` > from ? `${y}-12-31` : `${y + 1}-06-30`
  try { await api('/development/plans', { method: 'POST', body: { periodFrom: from, periodTo: to } }); await load() }
  catch (err) { error.value = apiErrorOf(err).message }
}
async function planAction(action: string) {
  if (!data.value?.plan) return
  try { await api(`/development/plans/${data.value.plan.id}/transition`, { method: 'POST', body: { action } }); notice.value = t('dev.planSent'); await load() }
  catch (err) { error.value = apiErrorOf(err).message }
}
async function createGoal() {
  error.value = ''
  try {
    const comp = data.value?.gap.items.find(i => i.competencyId === goalForm.value.competencyId)
    await api('/development/goals', { method: 'POST', body: { ...goalForm.value, planId: data.value?.plan?.id, competencyId: goalForm.value.competencyId || undefined, targetLevel: comp ? Math.max(comp.requiredLevel, comp.currentLevel + 1) : undefined } })
    goalForm.value = { title: '', kind: 'learning', dueAt: '', competencyId: '' }
    showGoalForm.value = false
    await load()
  }
  catch (err) { error.value = apiErrorOf(err).message }
}
async function createRequest() {
  error.value = ''
  try {
    await api('/development/requests', { method: 'POST', body: { kind: 'external', ...reqForm.value } })
    reqForm.value = { title: '', provider: '', format: 'online', justification: '' }
    showReqForm.value = false
    notice.value = t('dev.requestSent')
    await load()
  }
  catch (err) { error.value = apiErrorOf(err).message }
}
const isOverdue = (g: Goal) => !g.isFinal && g.dueAt < new Date().toISOString().slice(0, 10)
// Мокап DevelopmentPlanMobile: дати людяно — «30 вересня» (ціль), «15.08.2026 — 15.02.2027» (період плану).
const fmtDue = (d: string) => new Date(d).toLocaleDateString('uk-UA', { day: 'numeric', month: 'long' })
const fmtPeriod = (d: string) => new Date(d).toLocaleDateString('uk-UA', { day: '2-digit', month: '2-digit', year: 'numeric' })
function levelText(c: GapItem, displayAs: 'label' | 'value', level: number) {
  return displayAs === 'label' && level === c.currentLevel && c.currentLevelLabel ? c.currentLevelLabel : String(level)
}
</script>

<template>
  <div>
    <h1>{{ t('dev.title') }}</h1>
    <p v-if="error" class="error">{{ error }}</p>
    <p v-if="notice" class="notice">{{ notice }}</p>

    <div class="tabs">
      <button :class="['tab', { on: tab === 'profile' }]" @click="tab = 'profile'">{{ t('dev.tabProfile') }}</button>
      <button :class="['tab', { on: tab === 'plan' }]" @click="tab = 'plan'">{{ t('dev.tabPlan') }}</button>
      <button :class="['tab', { on: tab === 'requests' }]" @click="tab = 'requests'">{{ t('dev.tabRequests') }}</button>
    </div>

    <template v-if="data && tab === 'profile'">
      <p v-if="!data.gap.position" class="empty">{{ t('dev.noPosition') }}</p>
      <p v-else-if="!data.gap.profile" class="empty">{{ t('dev.noProfile', { position: data.gap.position.positionName }) }}</p>
      <template v-else>
        <p class="sub">{{ t('dev.profileOf', { position: data.gap.position.positionName }) }}</p>
        <div class="list">
          <div v-for="c in data.gap.items" :key="c.competencyId" class="card" :data-testid="`gap-${c.competencyId}`">
            <div class="row">
              <span class="card-title">{{ c.name }}<span v-if="c.isCritical" class="crit"> · {{ t('dev.critical') }}</span></span>
              <span :class="['badge', c.gap > 0 ? 'coral' : 'teal']">{{ levelText(c, data.gap.displayAs, c.currentLevel) }} / {{ levelText(c, data.gap.displayAs, c.requiredLevel) }}</span>
            </div>
            <div class="scale">
              <span v-for="n in c.maxLevel" :key="n" :class="['dot', { cur: n <= c.currentLevel, req: n === c.requiredLevel }]" />
            </div>
            <p v-if="c.source" class="sub">{{ t('dev.sourceLabel') }}: {{ t(`dev.source.${c.source}`, c.source) }}<span v-if="c.expiringSoon" class="crit"> · {{ t('dev.expiringSoon') }}</span></p>
            <p v-if="c.gap > 0 && c.whatToLearn.length" class="sub">{{ t('dev.whatToLearn') }}: <NuxtLink v-for="w in c.whatToLearn" :key="w.id" :to="`/learn/catalog?course=${w.id}`">{{ w.title }} </NuxtLink></p>
            <p v-else-if="c.gap > 0" class="sub">{{ t('dev.gapN', { n: c.gap }) }}</p>
          </div>
        </div>
      </template>
    </template>

    <template v-if="data && tab === 'plan'">
      <div v-if="!data.plan" class="card">
        <p class="sub">{{ t('dev.noPlan') }}</p>
        <button class="primary" @click="createPlan">{{ t('dev.createPlan') }}</button>
      </div>
      <div v-else class="goal-card">
        <div class="goal-label">{{ t('dev.planGoal') }}</div>
        <div class="goal-value">{{ data.plan.summary || t('dev.plan') }}</div>
        <div class="sub">{{ fmtPeriod(data.plan.periodFrom) }} — {{ fmtPeriod(data.plan.periodTo) }}<template v-if="data.plan.mentorName"> · {{ t('dev.planMentor', { name: data.plan.mentorName }) }}</template></div>
        <div class="row status-row">
          <span class="badge muted">{{ t(`dev.planStatus.${data.plan.status}`) }}</span>
        </div>
        <div class="actions">
          <button v-if="data.plan.status === 'draft'" class="primary" data-testid="plan-submit" @click="planAction('submit')">{{ t('dev.submitPlan') }}</button>
          <button v-if="data.plan.status === 'active'" class="chip" @click="planAction('review')">{{ t('dev.toReview') }}</button>
        </div>
      </div>

      <h2 class="h2">{{ t('dev.goals') }}</h2>
      <p v-if="data.goals.length === 0" class="empty">{{ t('dev.noGoals') }}</p>
      <div class="list">
        <NuxtLink v-for="g in data.goals" :key="g.id" :to="`/learn/development/goals/${g.id}`" class="card link">
          <div class="row">
            <span class="card-title">{{ g.title }}</span>
            <span :class="['badge', g.statusColor]">{{ g.statusName }}</span>
            <span v-if="!g.approvedAt && g.returnComment" class="badge coral">{{ t('dev.returned') }}</span>
            <span v-else-if="!g.approvedAt" class="badge">{{ t('dev.awaitingApproval') }}</span>
          </div>
          <span v-if="g.returnComment && !g.approvedAt" class="sub">{{ g.returnComment }}</span>
          <span :class="['sub', { overdue: isOverdue(g) }]">{{ t(`dev.kind.${g.kind}`) }} · {{ t('dev.due') }} {{ fmtDue(g.dueAt) }}{{ isOverdue(g) ? ` · ${t('dev.overdue')}` : '' }}</span>
          <div class="progress"><span :style="{ width: `${g.progressPct}%` }" /></div>
        </NuxtLink>
      </div>
      <button v-if="!showGoalForm" class="chip" data-testid="goal-add" @click="showGoalForm = true">+ {{ t('dev.addGoal') }}</button>
      <form v-else class="form" @submit.prevent="createGoal">
        <input v-model="goalForm.title" :placeholder="t('dev.goalTitle')" required minlength="3">
        <select v-model="goalForm.kind">
          <option v-for="k in ['competency', 'learning', 'result', 'project']" :key="k" :value="k">{{ t(`dev.kind.${k}`) }}</option>
        </select>
        <select v-if="goalForm.kind === 'competency'" v-model="goalForm.competencyId">
          <option value="">{{ t('dev.pickCompetency') }}</option>
          <option v-for="c in data.gap.items" :key="c.competencyId" :value="c.competencyId">{{ c.name }}</option>
        </select>
        <input v-model="goalForm.dueAt" type="date" required>
        <div class="actions">
          <button type="button" class="chip" @click="showGoalForm = false">{{ t('common.cancel') }}</button>
          <button type="submit" class="primary">{{ t('common.save') }}</button>
        </div>
      </form>
    </template>

    <template v-if="data && tab === 'requests'">
      <p v-if="!data.requests || (data.requests.external.length + data.requests.career.length === 0)" class="empty">{{ t('dev.noRequests') }}</p>
      <div v-if="data.requests" class="list">
        <div v-for="r in data.requests.external" :key="r.id" class="card">
          <div class="row"><span class="card-title">{{ r.title }}</span><span class="badge muted">{{ t(`dev.reqStatus.${r.status}`) }}</span></div>
        </div>
        <div v-for="r in data.requests.career" :key="r.id" class="card">
          <div class="row"><span class="card-title">{{ t('dev.career') }}: {{ r.targetPosition }}</span><span class="badge muted">{{ t(`dev.reqStatus.${r.status}`) }}</span></div>
        </div>
      </div>
      <button v-if="!showReqForm" class="chip" @click="showReqForm = true">+ {{ t('dev.newRequest') }}</button>
      <form v-else class="form" @submit.prevent="createRequest">
        <input v-model="reqForm.title" :placeholder="t('dev.reqTitle')" required minlength="3">
        <input v-model="reqForm.provider" :placeholder="t('dev.reqProvider')">
        <select v-model="reqForm.format"><option value="online">Online</option><option value="offline">Offline</option></select>
        <textarea v-model="reqForm.justification" rows="3" :placeholder="t('dev.reqWhy')" />
        <div class="actions">
          <button type="button" class="chip" @click="showReqForm = false">{{ t('common.cancel') }}</button>
          <button type="submit" class="primary">{{ t('dev.send') }}</button>
        </div>
      </form>
    </template>
  </div>
</template>

<style scoped>
h1 { margin: 0 0 var(--space-3); font-weight: 900; }
.h2 { margin: var(--space-4) 0 var(--space-2); font-weight: 800; font-size: var(--font-size-title-l); }
.tabs { display: flex; gap: var(--space-1); margin-bottom: var(--space-3); overflow-x: auto; }
.tab { font: inherit; font-weight: 700; border: 1px solid var(--color-bg-line); background: transparent; border-radius: var(--radius-pill); padding: var(--space-1) var(--space-3); white-space: nowrap; color: var(--color-ink-muted); }
.tab.on { background: var(--color-ink); color: var(--color-bg); border-color: var(--color-ink); }
.list { display: grid; gap: var(--space-2); margin-bottom: var(--space-3); }
.card { background: var(--color-bg-soft); border-radius: var(--radius-l); padding: var(--space-3); display: grid; gap: var(--space-2); color: inherit; text-decoration: none; }
.goal-card { background: var(--color-bg-soft); border: 2px solid var(--color-bg-line); border-radius: var(--radius-l); padding: var(--space-4); margin-bottom: var(--space-3); }
.goal-label { color: var(--color-ink-muted); font-size: var(--font-size-body-s); font-weight: 700; }
.goal-value { font-size: var(--font-size-title-l); font-weight: 900; margin-top: 2px; }
.status-row { margin-top: var(--space-2); }
.card.link:hover { outline: 2px solid var(--color-sun); }
.row { display: flex; justify-content: space-between; gap: var(--space-2); align-items: center; }
.card-title { font-weight: 800; }
.crit { color: var(--color-coral-ink); font-size: var(--font-size-body-s); }
.sub { color: var(--color-ink-muted); font-size: var(--font-size-body-s); margin: 0; }
.sub a { color: var(--color-ink); font-weight: 700; }
.overdue { color: var(--color-coral-ink); font-weight: 700; }
.empty, .error, .notice { padding: var(--space-3); border-radius: var(--radius-m); }
.empty { color: var(--color-ink-muted); }
.error { background: var(--color-coral); color: var(--color-coral-deep); }
.notice { background: var(--color-teal); color: var(--color-teal-deep); }
.badge { font-size: var(--font-size-body-s); font-weight: 700; border-radius: var(--radius-pill); padding: 2px var(--space-2); white-space: nowrap; }
.badge.teal { background: var(--color-teal); color: var(--color-teal-deep); }
.badge.coral { background: var(--color-coral); color: var(--color-coral-deep); }
.badge.sun { background: var(--color-sun); color: var(--color-ink); }
.badge.muted { background: var(--color-bg); color: var(--color-ink-muted); }
.scale { display: flex; gap: 4px; }
.dot { width: 22px; height: 8px; border-radius: 4px; background: var(--color-bg-line); }
.dot.cur { background: var(--color-teal); }
.dot.req { outline: 2px solid var(--color-sun); outline-offset: 1px; }
.progress { height: 6px; border-radius: 3px; background: var(--color-bg-line); overflow: hidden; }
.progress span { display: block; height: 100%; background: var(--color-teal); }
.form { display: grid; gap: var(--space-2); background: var(--color-bg-soft); padding: var(--space-3); border-radius: var(--radius-l); }
.form input, .form select, .form textarea { font: inherit; padding: var(--space-2); border: 1px solid var(--color-bg-line); border-radius: var(--radius-m); background: var(--color-bg); }
.actions { display: flex; flex-wrap: wrap; gap: var(--space-2); justify-content: flex-end; }
.chip, .primary { font: inherit; font-weight: 700; border-radius: var(--radius-pill); padding: var(--space-2) var(--space-3); cursor: pointer; }
.chip { border: 1px solid var(--color-bg-line); background: transparent; color: var(--color-ink-muted); }
.primary { border: none; background: var(--color-sun); color: var(--color-ink); font-weight: 800; }
</style>
