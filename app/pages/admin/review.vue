<script setup lang="ts">
import type { ContentBlock } from '../../../shared/schemas/content'

definePageMeta({ layout: 'admin', middleware: 'admin-scope', requiredScope: 'review.queue' })

const { t } = useI18n()
const { api } = useApi()

interface Item {
  answerId: string
  attemptId: string
  fullName: string
  quizTitle: string
  submittedAt: string | null
  hoursWaiting: number
  question: { kind: string, stem: ContentBlock[], points: number, isCritical: boolean, criteria: string[], reference: string | null } | null
  answer: unknown
}

const queue = ref<Item[]>([])
const current = ref<Item | null>(null)
const comment = ref('')
const error = ref('')
const notice = ref('')
const busy = ref(false)

async function load() {
  try {
    queue.value = await api<Item[]>('/review/queue')
    if (!current.value || !queue.value.some(i => i.answerId === current.value!.answerId)) {
      current.value = queue.value[0] ?? null
    }
  }
  catch (err) {
    error.value = apiErrorOf(err).message
  }
}
onMounted(load)

function answerText(a: unknown): string {
  const obj = a as { text?: string } | null
  return obj?.text ?? JSON.stringify(a)
}

async function decide(isCorrect: boolean) {
  if (!current.value) return
  if (!isCorrect && comment.value.trim().length < 10) {
    error.value = t('review.commentRequired')
    return
  }
  busy.value = true
  error.value = ''
  try {
    const r = await api<{ attemptStatus: string }>(`/review/answers/${current.value.answerId}/grade`, {
      method: 'POST',
      body: { isCorrect, comment: comment.value.trim() || undefined },
    })
    notice.value = r.attemptStatus === 'review' ? t('review.savedMore') : t('review.savedFinal', { status: r.attemptStatus })
    comment.value = ''
    // Сразу следующая карточка (docs/05 §5.5)
    queue.value = queue.value.filter(i => i.answerId !== current.value!.answerId)
    current.value = queue.value[0] ?? null
  }
  catch (err) {
    error.value = apiErrorOf(err).message
  }
  finally {
    busy.value = false
  }
}
</script>

<template>
  <div>
    <header class="head">
      <h1>{{ t('review.title') }}</h1>
      <span class="count">{{ t('review.left', { n: queue.length }) }}</span>
    </header>

    <p v-if="error" class="error">{{ error }}</p>
    <p v-if="notice" class="notice">{{ notice }}</p>

    <div v-if="!current" class="empty">{{ t('review.empty') }}</div>

    <div v-else class="card">
      <div class="meta">
        <b>{{ current.fullName }}</b> · {{ current.quizTitle }}
        <span :class="['ago', { late: current.hoursWaiting >= 48 }]">
          · {{ t('review.hoursAgo', { n: current.hoursWaiting }) }}
        </span>
      </div>

      <section class="block">
        <h2>{{ t('review.question') }}</h2>
        <LessonBlocks v-if="current.question" :blocks="current.question.stem" :blocks-state="{}" readonly />
        <span v-if="current.question?.isCritical" class="critical">{{ t('quiz.critical') }}</span>
      </section>

      <section v-if="current.question?.criteria.length" class="block">
        <h2>{{ t('review.criteria') }}</h2>
        <ul class="criteria">
          <li v-for="c in current.question.criteria" :key="c">{{ c }}</li>
        </ul>
      </section>

      <section v-if="current.question?.reference" class="block muted">
        <h2>{{ t('review.reference') }}</h2>
        <p>{{ current.question.reference }}</p>
      </section>

      <section class="block answer">
        <h2>{{ t('review.answer') }}</h2>
        <p>{{ answerText(current.answer) }}</p>
      </section>

      <textarea v-model="comment" rows="3" :placeholder="t('review.commentHint')" />

      <div class="actions">
        <button class="ok" :disabled="busy" @click="decide(true)">{{ t('review.accept') }}</button>
        <button class="bad" :disabled="busy" @click="decide(false)">{{ t('review.reject') }}</button>
      </div>
    </div>
  </div>
</template>

<style scoped>
.head {
  display: flex;
  align-items: baseline;
  gap: var(--space-3);
  margin-bottom: var(--space-4);
}

h1 {
  margin: 0;
  font-weight: 900;
}

.count {
  color: var(--color-ink-muted);
}

.card {
  background: var(--color-bg-soft);
  border-radius: var(--radius-l);
  padding: var(--space-5);
  max-width: 720px;
  display: grid;
  gap: var(--space-4);
}

.meta {
  color: var(--color-ink-muted);
  font-size: var(--font-size-body-s);
}

.ago.late {
  color: var(--color-coral-ink);
  font-weight: 700;
}

.block h2 {
  margin: 0 0 var(--space-2);
  font-size: var(--font-size-body-s);
  color: var(--color-ink-faint);
  text-transform: uppercase;
  letter-spacing: 0.04em;
}

.block.muted {
  color: var(--color-ink-muted);
}

.block p {
  margin: 0;
  white-space: pre-wrap;
}

.answer {
  background: var(--color-bg);
  border-radius: var(--radius-m);
  padding: var(--space-4);
}

.criteria {
  margin: 0;
  padding-left: var(--space-5);
}

.critical {
  display: inline-block;
  margin-top: var(--space-2);
  font-size: var(--font-size-body-s);
  font-weight: 800;
  background: var(--color-coral);
  color: var(--color-coral-deep);
  border-radius: var(--radius-pill);
  padding: 2px var(--space-3);
}

textarea {
  font: inherit;
  border: 1px solid var(--color-bg-line);
  border-radius: var(--radius-s);
  padding: var(--space-3);
  background: var(--color-bg);
  color: var(--color-ink);
  resize: vertical;
}

.actions {
  display: flex;
  gap: var(--space-3);
}

.ok,
.bad {
  font: inherit;
  font-weight: 800;
  border: none;
  border-radius: var(--radius-pill);
  padding: var(--space-3) var(--space-5);
  cursor: pointer;
}

.ok {
  background: var(--color-teal);
  color: var(--color-teal-deep);
}

.bad {
  background: var(--color-coral);
  color: var(--color-coral-deep);
}

.empty {
  color: var(--color-ink-faint);
  padding: var(--space-7);
  text-align: center;
}

.error { color: var(--color-coral-ink); }
.notice { color: var(--color-teal-ink); }
</style>
