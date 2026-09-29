<script setup lang="ts">
/**
 * Вкладка «Проходження» картки кандидата (docs/v2/28-recruiting-candidates.md §5.3 п. 2):
 * призначення зі статусами з п'яти канонічних, прогрес, спроби, «Час на контент» і
 * «Час на випробування» (docs/v2/37 §7.11).
 *
 * Усе рахує сервер (`GET /candidates/:id/progress`): статус — той, що поставили правила
 * проходження, час — зарахований згорткою, а не сирі тики. Екран лише показує. Рядки — картками,
 * а не таблицею: на 320 px сім колонок не вміщуються.
 *
 * Порожній стан (§5.3): «Кандидату ще нічого не призначено» + кнопка «Призначити контент» —
 * форма призначення з аудиторією «цей кандидат» (`/admin/assignments/new?candidateId=`).
 */
import type { EnrollmentStatus } from '#shared/enums'

const props = defineProps<{ candidateId: string, canAssign: boolean }>()

const { t } = useI18n()
const { api } = useApi()
const { formatDate } = useFormat()

interface Item {
  enrollmentId: string
  title: string | null
  status: EnrollmentStatus
  progressPct: number
  dueAt: string | null
  overdue: boolean
  attemptsCount: number
  contentSeconds: number
  attemptSeconds: number
}
interface Attempt {
  id: string
  title: string | null
  attemptNo: number
  status: string
  score: number | null
  maxScore: number | null
  passed: boolean | null
  startedAt: string
  submittedAt: string | null
}

const data = ref<{ items: Item[], attempts: Attempt[] } | null>(null)
const error = ref('')

async function load() {
  error.value = ''
  try { data.value = await api<{ items: Item[], attempts: Attempt[] }>(`/candidates/${props.candidateId}/progress`) }
  catch (err) { error.value = apiErrorOf(err).message }
}
onMounted(load)

const minutes = (s: number) => (s ? t('candidate.progress.minutes', { n: Math.max(1, Math.round(s / 60)) }) : '—')
const dateOf = (v: string | null) => v ? formatDate(new Date(v), { day: '2-digit', month: '2-digit', year: 'numeric' }) : '—'
const pct = (a: Attempt) => a.maxScore ? `${Math.round(Number(a.score ?? 0) / a.maxScore * 100)}%` : '—'
</script>

<template>
  <div class="stack">
    <p v-if="error" class="error" role="alert">{{ error }}</p>

    <template v-if="data">
      <div v-if="!data.items.length" class="empty">
        <p class="sub">{{ t('candidate.progress.empty') }}</p>
        <NuxtLink v-if="canAssign" class="btn" :to="`/admin/assignments/new?candidateId=${candidateId}`">
          {{ t('candidate.progress.assign') }}
        </NuxtLink>
      </div>

      <ul v-else class="items">
        <li v-for="i in data.items" :key="i.enrollmentId" class="item">
          <div class="row between">
            <strong>{{ i.title ?? '—' }}</strong>
            <span :class="['pill', i.overdue ? 'tone-coral' : i.status === 'done' ? 'tone-teal' : i.status === 'failed' ? 'tone-coral' : 'tone-ink']">
              {{ i.overdue ? t('enrollment.overdue') : t(`enrollment.${i.status}`) }}
            </span>
          </div>
          <div class="bar" role="progressbar" :aria-valuenow="i.progressPct" aria-valuemin="0" aria-valuemax="100" :aria-label="t('candidate.progress.progress')">
            <span :style="{ width: `${Math.min(100, i.progressPct)}%` }" />
          </div>
          <dl class="facts">
            <dt>{{ t('candidate.progress.progress') }}</dt><dd>{{ Math.round(i.progressPct) }}%</dd>
            <dt>{{ t('candidate.progress.attempts') }}</dt><dd>{{ i.attemptsCount }}</dd>
            <dt>{{ t('candidate.progress.content') }}</dt><dd>{{ minutes(i.contentSeconds) }}</dd>
            <dt>{{ t('candidate.progress.attempt') }}</dt><dd>{{ minutes(i.attemptSeconds) }}</dd>
            <dt>{{ t('candidate.progress.due') }}</dt><dd>{{ dateOf(i.dueAt) }}</dd>
          </dl>
        </li>
      </ul>

      <template v-if="data.attempts.length">
        <h3 class="h4">{{ t('candidate.progress.attemptsTitle') }}</h3>
        <ul class="items">
          <li v-for="a in data.attempts" :key="a.id" class="item">
            <div class="row between">
              <strong>{{ a.title ?? '—' }} · {{ t('candidate.progress.no') }}{{ a.attemptNo }}</strong>
              <span v-if="a.passed !== null" :class="['pill', a.passed ? 'tone-teal' : 'tone-coral']">
                {{ a.passed ? t('candidate.progress.passed') : t('candidate.progress.notPassed') }}
              </span>
            </div>
            <p class="sub">{{ t('candidate.progress.score') }}: {{ pct(a) }} · {{ dateOf(a.submittedAt ?? a.startedAt) }}</p>
          </li>
        </ul>
      </template>
    </template>
  </div>
</template>

<style scoped>
.stack { display: grid; gap: var(--space-3); }
.row { display: flex; gap: var(--space-2); align-items: center; flex-wrap: wrap; }
.between { justify-content: space-between; }
.sub { margin: 0; color: var(--color-ink-muted); font-size: var(--font-size-body-s); }
.h4 { margin: 0; font-size: var(--font-size-body-s); font-weight: 900; text-transform: uppercase; letter-spacing: 0.04em; color: var(--color-ink-muted); }
.empty { display: grid; gap: var(--space-2); justify-items: start; }
.items { list-style: none; margin: 0; padding: 0; display: grid; gap: var(--space-2); }
.item { border: 1px solid var(--color-bg-line-soft); border-radius: var(--radius-s); padding: var(--space-2) var(--space-3); display: grid; gap: var(--space-2); }
.bar { height: var(--space-1); background: var(--color-bg-line-soft); border-radius: var(--radius-pill); overflow: hidden; }
.bar span { display: block; height: 100%; background: var(--color-teal); }
.facts { display: grid; grid-template-columns: max-content 1fr; gap: var(--space-1) var(--space-3); margin: 0; font-size: var(--font-size-body-s); }
.facts dt { color: var(--color-ink-muted); }
.facts dd { margin: 0; }
.tone-teal { background: var(--color-teal-soft); }
.tone-coral { background: var(--color-coral-soft); }
.tone-ink { background: var(--color-bg-soft); }
</style>
