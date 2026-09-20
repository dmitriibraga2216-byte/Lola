<script setup lang="ts">
definePageMeta({ layout: 'learner' })
const { t } = useI18n()
const { api } = useApi()
const { me } = useAuth()
const route = useRoute()

interface Status { code: string, name: string, color: string, requiresComment: boolean, isSuccess: boolean }
interface Goal {
  id: string, userId: string, title: string, description: string | null, kind: string, dueAt: string, metric: string | null, progressPct: number, result: string | null, evaluation: string | null, targetLevel: number | null, targetLevelLabel: string | null, displayAs: 'label' | 'value'
  status: Status | null, transitions: Status[]
  log: { id: string, fromStatus: string | null, toStatus: string, actorName: string | null, comment: string | null, createdAt: string }[]
  comments: { id: string, authorName: string, body: string, createdAt: string }[]
  competency: { name: string, levels: { level: number, title: string }[] } | null
}
const goal = ref<Goal | null>(null)
const statusNames = ref<Record<string, string>>({})
const sn = (code: string | null) => code ? (statusNames.value[code] ?? code) : '∅'
const error = ref('')
const comment = ref('')
const transComment = ref('')
const evaluation = ref('')
const progress = ref(0)
const result = ref('')
const isMine = computed(() => goal.value?.userId === me.value?.user.id)

async function load() {
  try {
    goal.value = await api<Goal>(`/development/goals/${route.params.id}`)
    if (!Object.keys(statusNames.value).length) statusNames.value = Object.fromEntries((await api<Status[]>('/development/goal-statuses')).map(s => [s.code, s.name]))
    progress.value = goal.value.progressPct
    result.value = goal.value.result ?? ''
  }
  catch (err) { error.value = apiErrorOf(err).message }
}
onMounted(load)

async function saveProgress() {
  try { await api(`/development/goals/${route.params.id}`, { method: 'PATCH', body: { progressPct: Number(progress.value), result: result.value || undefined } }); await load() }
  catch (err) { error.value = apiErrorOf(err).message }
}
async function transition(to: string) {
  error.value = ''
  try {
    await api(`/development/goals/${route.params.id}/transition`, { method: 'POST', body: { to, comment: transComment.value || undefined, evaluation: evaluation.value || undefined } })
    transComment.value = ''
    await load()
  }
  catch (err) { error.value = apiErrorOf(err).message }
}
async function addComment() {
  if (!comment.value.trim()) return
  try { await api(`/development/goals/${route.params.id}/comments`, { method: 'POST', body: { body: comment.value } }); comment.value = ''; await load() }
  catch (err) { error.value = apiErrorOf(err).message }
}
const fmt = (d: string) => new Date(d).toLocaleString('uk-UA', { dateStyle: 'short', timeStyle: 'short' })
</script>

<template>
  <div>
    <NuxtLink :to="isMine ? '/learn/development' : '/admin/development/team'" class="back">← {{ t('common.back') }}</NuxtLink>
    <p v-if="error" class="error">{{ error }}</p>
    <template v-if="goal">
      <div class="head">
        <h1>{{ goal.title }}</h1>
        <span v-if="goal.status" :class="['badge', goal.status.color]" data-testid="goal-status">{{ goal.status.name }}</span>
      </div>
      <p class="sub">{{ t(`dev.kind.${goal.kind}`) }} · {{ t('dev.due') }} {{ goal.dueAt }}<template v-if="goal.competency"> · {{ goal.competency.name }}<template v-if="goal.targetLevel"> → {{ t('dev.level') }} {{ goal.displayAs === 'label' ? goal.targetLevelLabel : goal.targetLevel }}</template></template></p>
      <p v-if="goal.description" class="text">{{ goal.description }}</p>
      <p v-if="goal.metric" class="sub">{{ t('dev.metric') }}: {{ goal.metric }}</p>

      <section class="card">
        <h2>{{ t('dev.progress') }} — {{ goal.progressPct }}%</h2>
        <div class="progress"><span :style="{ width: `${goal.progressPct}%` }" /></div>
        <template v-if="isMine && !goal.status?.isSuccess">
          <input v-model="progress" type="range" min="0" max="100" step="5">
          <textarea v-model="result" rows="2" :placeholder="t('dev.resultPh')" />
          <button class="chip" @click="saveProgress">{{ t('common.save') }}</button>
        </template>
        <p v-else-if="goal.result" class="text">{{ goal.result }}</p>
        <p v-if="goal.evaluation" class="eval">{{ t('dev.evaluation') }}: {{ goal.evaluation }}</p>
      </section>

      <section v-if="goal.transitions.length" class="card">
        <h2>{{ t('dev.changeStatus') }}</h2>
        <textarea v-model="transComment" rows="2" :placeholder="t('dev.commentPh')" />
        <textarea v-if="!isMine" v-model="evaluation" rows="2" :placeholder="t('dev.evaluationPh')" />
        <div class="actions">
          <button v-for="s in goal.transitions" :key="s.code" :class="['chip', s.color]" :data-testid="`to-${s.code}`" @click="transition(s.code)">{{ s.name }}</button>
        </div>
      </section>

      <section class="card">
        <h2>{{ t('dev.protocol') }}</h2>
        <ul class="log">
          <li v-for="l in goal.log" :key="l.id">
            <span class="when">{{ fmt(l.createdAt) }}</span> <b>{{ l.actorName ?? '—' }}</b>: {{ sn(l.fromStatus) }} → {{ sn(l.toStatus) }}<span v-if="l.comment"> — {{ l.comment }}</span>
          </li>
        </ul>
      </section>

      <section class="card">
        <h2>{{ t('dev.comments') }}</h2>
        <ul class="log">
          <li v-for="c in goal.comments" :key="c.id"><span class="when">{{ fmt(c.createdAt) }}</span> <b>{{ c.authorName }}</b>: {{ c.body }}</li>
        </ul>
        <textarea v-model="comment" rows="2" :placeholder="t('dev.commentPh')" />
        <button class="chip" @click="addComment">{{ t('dev.send') }}</button>
      </section>
    </template>
  </div>
</template>

<style scoped>
.back { color: var(--color-ink-muted); text-decoration: none; font-weight: 700; display: inline-block; margin-bottom: var(--space-2); }
.head { display: flex; justify-content: space-between; align-items: start; gap: var(--space-2); }
h1 { margin: 0; font-weight: 900; }
h2 { margin: 0; font-weight: 800; font-size: var(--font-size-title-l); }
.sub { color: var(--color-ink-muted); font-size: var(--font-size-body-s); margin: var(--space-1) 0; }
.text { margin: var(--space-2) 0; white-space: pre-wrap; }
.eval { background: var(--color-sun); padding: var(--space-2); border-radius: var(--radius-m); margin: 0; }
.card { background: var(--color-bg-soft); border-radius: var(--radius-l); padding: var(--space-3); display: grid; gap: var(--space-2); margin-top: var(--space-3); }
.badge { font-size: var(--font-size-body-s); font-weight: 700; border-radius: var(--radius-pill); padding: 2px var(--space-2); white-space: nowrap; }
.badge.teal, .chip.teal { background: var(--color-teal); color: var(--color-teal-deep); border-color: transparent; }
.badge.coral, .chip.coral { background: var(--color-coral); color: var(--color-coral-deep); border-color: transparent; }
.badge.sun, .chip.sun { background: var(--color-sun); color: var(--color-sun-ink); border-color: transparent; }
.badge.muted { background: var(--color-bg); color: var(--color-ink-muted); }
.progress { height: 8px; border-radius: 4px; background: var(--color-bg-line); overflow: hidden; }
.progress span { display: block; height: 100%; background: var(--color-teal); }
textarea { font: inherit; padding: var(--space-2); border: 1px solid var(--color-bg-line); border-radius: var(--radius-m); background: var(--color-bg); }
.actions { display: flex; flex-wrap: wrap; gap: var(--space-2); }
.chip { font: inherit; font-weight: 700; border-radius: var(--radius-pill); padding: var(--space-2) var(--space-3); cursor: pointer; border: 1px solid var(--color-bg-line); background: transparent; color: var(--color-ink); justify-self: start; }
.log { list-style: none; margin: 0; padding: 0; display: grid; gap: var(--space-1); font-size: var(--font-size-body-s); }
.when { color: var(--color-ink-muted); }
.error { background: var(--color-coral); color: var(--color-coral-deep); padding: var(--space-3); border-radius: var(--radius-m); }
</style>
