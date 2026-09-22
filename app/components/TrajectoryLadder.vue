<script setup lang="ts">
/**
 * Лента прохождения траектории по мокапу MyTrajectory: «Пройдено 4 з 9», процент, шаги в колонку —
 * пройденные бирюзовые с галочкой, текущий солнечный, будущие приглушённые; затримка — «Відкриється {дата}».
 * Только фактический путь человека, без канвы (docs/17 §5.2). Сервер считает, компонент показывает.
 */
export interface Step { nodeId: string, kind: string, title: string | null, contentTitle: string | null, contentType: string | null, days: number | null, status: string, activatedAt: string | null, finishedAt: string | null, firesAt: string | null, score: string | null, passed: boolean | null, reason: string | null, assignmentId: string | null, courseEnrollmentId: string | null, courseProgress: string | null }
export interface Ladder { id: string, title: string, status: string, progressPct: string, mentorId: string | null, total: number, done: number, steps: Step[] }

const props = defineProps<{ ladder: Ladder, mine?: boolean, canConfirm?: boolean }>()
const emit = defineEmits<{ confirm: [nodeId: string] }>()
const { t } = useI18n()

const pct = computed(() => props.ladder.total ? Math.round((props.ladder.done / props.ladder.total) * 100) : Number(props.ladder.progressPct))
const fmt = (d: string | null) => d ? new Date(d).toLocaleDateString('uk-UA', { day: 'numeric', month: 'long' }) : ''
// Затримка/закриття доступу (мокап MyTrajectory, docs/31, screens-7): назва завжди
// «Затримка N днів» — з кількістю днів, яку сервер уже рахує (`days` вузла), а не
// довільна підпис-назва блоку (та лишається лише в редакторі полотна).
function stepTitle(s: Step) {
  if (s.kind === 'delay' && s.days != null) return t('traj.step.delayTitle', { n: s.days })
  if (s.kind === 'stop_delay' && s.days != null) return t('traj.step.stopDelayTitle', { n: s.days })
  return s.title || s.contentTitle || t(`traj.kind.${s.kind}`)
}
function stepSub(s: Step) {
  if (s.kind === 'task') {
    const type = s.contentType ? t(`contentType.${s.contentType}`) : ''
    if (s.status === 'done') return `${type} · ${t('traj.step.done')}${s.score != null ? ` ${Number(s.score)}%` : s.courseProgress != null ? ' 100%' : ''}`
    if (s.status === 'failed') return `${type} · ${s.reason === 'access_closed' ? t('traj.step.closed') : t('traj.step.failed')}`
    if (s.status === 'available' || s.status === 'in_progress') return `${type} · ${s.courseProgress != null && Number(s.courseProgress) > 0 ? t('traj.step.inProgress', { n: Number(s.courseProgress) }) : t('traj.step.open')}`
    return `${type} · ${t('traj.step.notAssigned')}`
  }
  if (s.kind === 'delay') return s.status === 'done' ? t('traj.step.done') : s.firesAt ? t('traj.step.opensAt', { date: fmt(s.firesAt) }) : t('traj.step.locked')
  if (s.kind === 'stop_delay') return t('traj.step.stopDelay')
  if (s.kind === 'mentor') return s.status === 'done' ? t('traj.step.confirmed') : s.status === 'available' ? t('traj.step.waitingMentor') : t('traj.step.locked')
  if (s.kind === 'branch') return s.status === 'done' ? (s.passed ? t('traj.cond.passed') : t('traj.cond.failed')) : t('traj.step.locked')
  return s.status === 'done' ? t('traj.step.done') : t('traj.step.waiting')
}
const tone = (s: Step) => s.status === 'done' ? 'done' : s.status === 'failed' ? 'failed' : s.status === 'available' || s.status === 'in_progress' ? 'current' : 'future'
function stepLink(s: Step) {
  if (!props.mine || (s.status !== 'available' && s.status !== 'in_progress')) return null
  if (s.kind === 'task' && s.contentType === 'course' && s.courseEnrollmentId) return `/learn/${s.courseEnrollmentId}`
  if (s.kind === 'task') return '/learn'
  return null
}
</script>

<template>
  <div class="ladder">
    <header class="head">
      <h1 class="title">{{ ladder.title }}</h1>
      <div class="progress-row">
        <span class="count">{{ t('traj.passedOf', { done: ladder.done, total: ladder.total }) }}</span>
        <span class="pct">{{ pct }}%</span>
      </div>
      <div class="bar" role="progressbar" :aria-valuenow="pct" aria-valuemin="0" aria-valuemax="100"><span :style="{ width: `${pct}%` }" /></div>
      <span v-if="ladder.status === 'done'" class="badge done">{{ t('traj.state.done') }}</span>
      <span v-else-if="ladder.status === 'failed'" class="badge failed">{{ t('traj.state.failed') }}</span>
    </header>
    <ol class="steps">
      <li v-for="s in ladder.steps" :key="s.nodeId" :class="['step', tone(s)]">
        <span class="mark" aria-hidden="true">
          <template v-if="tone(s) === 'done'">✓</template>
          <template v-else-if="tone(s) === 'failed'">×</template>
          <template v-else-if="tone(s) === 'future'">🔒</template>
          <template v-else>→</template>
        </span>
        <div class="body">
          <component :is="stepLink(s) ? 'NuxtLink' : 'span'" :to="stepLink(s) ?? undefined" class="step-title">{{ stepTitle(s) }}</component>
          <span class="step-sub">{{ stepSub(s) }}</span>
          <button v-if="s.kind === 'mentor' && s.status === 'available' && canConfirm" class="btn primary small confirm" type="button" @click="emit('confirm', s.nodeId)">{{ t('traj.confirmStep') }}</button>
        </div>
      </li>
    </ol>
  </div>
</template>

<style scoped>
.head { display: grid; gap: var(--space-2); margin-bottom: var(--space-4); }
.title { margin: 0; font-size: var(--font-size-title-l); font-weight: 900; }
.progress-row { display: flex; justify-content: space-between; font-weight: 800; }
.pct { color: var(--color-teal-ink); }
.bar { height: 8px; background: var(--color-bg-line-soft); border-radius: var(--radius-pill); overflow: hidden; }
.bar span { display: block; height: 100%; background: var(--color-teal); border-radius: var(--radius-pill); }
.badge { justify-self: start; }
.steps { list-style: none; margin: 0; padding: 0; display: grid; gap: var(--space-2); }
.step { display: flex; gap: var(--space-3); align-items: flex-start; padding: var(--space-3) var(--space-4); border-radius: var(--radius-s); border: 1px solid var(--color-bg-line-soft); background: var(--color-bg-soft); }
.step.done { border-color: var(--color-teal); background: var(--color-teal-soft); }
.step.current { border-color: var(--color-sun); background: var(--color-sun-soft); }
.step.failed { border-color: var(--color-coral); background: var(--color-coral-soft); }
.step.future { color: var(--color-ink-muted); }
.mark { flex: none; width: 28px; height: 28px; border-radius: 50%; display: grid; place-items: center; font-weight: 900; background: var(--color-bg); }
.step.done .mark { background: var(--color-teal); color: var(--color-teal-deep); }
.step.current .mark { background: var(--color-sun); color: var(--color-sun-ink); }
.step.failed .mark { background: var(--color-coral); color: var(--color-coral-deep); }
.body { display: grid; gap: 2px; min-width: 0; }
.step-title { font-weight: 800; color: inherit; text-decoration: none; }
a.step-title { text-decoration: underline; }
.step-sub { font-size: var(--font-size-body-s); color: var(--color-ink-muted); }
.confirm { justify-self: start; margin-top: var(--space-2); }
</style>
