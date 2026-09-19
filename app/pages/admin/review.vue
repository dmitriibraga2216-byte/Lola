<script setup lang="ts">
import type { ContentBlock } from '../../../shared/schemas/content'

/**
 * «Відповіді на перевірку» по мокапу ReviewAnswers (docs/12 §14.4): очередь по ответам, чипы
 * Неперевірені · Перевірені · Усі, фильтры «мітка питання · Поза програмами · Поза курсами · Точка»,
 * карточка ответа с вопросом, «Бал N з N · Зарахувати / Не зараховано», «Підказка для перевіряючого».
 */
definePageMeta({ layout: 'admin', middleware: 'admin-scope', requiredScope: 'review.queue' })

const { t } = useI18n()
const { api } = useApi()

interface Item {
  answerId: string
  attemptId: string
  attemptStatus: string
  fullName: string
  positionName: string | null
  locationId: string | null
  locationName: string | null
  quizTitle: string
  submittedAt: string | null
  hoursWaiting: number
  questionTags: string[]
  question: { kind: string, stem: ContentBlock[], points: number, isCritical: boolean, criteria: string[], reference: string | null, graderHint: string | null } | null
  answer: unknown
  files: { mediaId: string, name: string, kind: string }[]
  isCorrect: boolean | null
  score: number | null
  reviewComment: string | null
}
interface Location { id: string, name: string }

const TABS = ['unchecked', 'checked', 'all'] as const
const tab = ref<typeof TABS[number]>('unchecked')
const tag = ref('')
const outsidePrograms = ref(false)
const outsideCourses = ref(false)
const locationId = ref('')
const locations = ref<Location[]>([])
const items = ref<Item[]>([])
const counts = ref<{ unchecked: number }>({ unchecked: 0 })
const scores = ref<Record<string, number>>({})
const comments = ref<Record<string, string>>({})
const error = ref('')
const notice = ref('')
const busy = ref('')
const mediaUrls = ref<Record<string, string>>({})

async function load() {
  error.value = ''
  try {
    items.value = await api<Item[]>('/review/answers', { query: {
      checked: tab.value,
      tags: tag.value || undefined,
      outsidePrograms: outsidePrograms.value || undefined,
      outsideCourses: outsideCourses.value || undefined,
      locationId: locationId.value || undefined,
    } })
    for (const i of items.value) {
      scores.value[i.answerId] ??= i.score ?? i.question?.points ?? 0
      for (const f of i.files) {
        if (!mediaUrls.value[f.mediaId]) api<{ urls: Record<string, string> }>(`/media/${f.mediaId}`).then(m => { mediaUrls.value[f.mediaId] = m.urls['768'] || m.urls.original! }).catch(() => {})
      }
    }
    if (tab.value === 'unchecked') counts.value.unchecked = items.value.length
    else counts.value.unchecked = (await api<Item[]>('/review/answers', { query: { checked: 'unchecked' } })).length
  }
  catch (err) {
    error.value = apiErrorOf(err).message
  }
}
onMounted(async () => {
  locations.value = await api<Location[]>('/refs/locations').catch(() => [])
  await load()
})
watch([tab, tag, outsidePrograms, outsideCourses, locationId], load)

const allTags = computed(() => [...new Set(items.value.flatMap(i => i.questionTags))])

function answerText(a: unknown): string {
  const obj = a as { text?: string } | null
  return obj?.text ?? ''
}
const initials = (name: string) => name.split(' ').slice(0, 2).map(p => p[0] ?? '').join('').toUpperCase()

async function decide(item: Item, isCorrect: boolean) {
  const comment = (comments.value[item.answerId] ?? '').trim()
  if (!isCorrect && comment.length < 10) {
    error.value = t('review.commentRequired')
    return
  }
  busy.value = item.answerId
  error.value = ''
  try {
    const r = await api<{ attemptStatus: string }>(`/review/answers/${item.answerId}/grade`, {
      method: 'POST',
      body: { isCorrect, score: isCorrect ? scores.value[item.answerId] : 0, comment: comment || undefined },
    })
    notice.value = r.attemptStatus === 'review' ? t('review.savedMore') : t('review.savedFinal', { status: t(`review.attemptStatus.${r.attemptStatus}`) })
    await load()
  }
  catch (err) {
    error.value = apiErrorOf(err).message
  }
  finally {
    busy.value = ''
  }
}
</script>

<template>
  <div>
    <PageHeader :title="t('review.title')" :crumbs="[{ label: t('admin.section.learning') }, { label: t('review.title') }]" />

    <div class="chips" role="tablist">
      <button v-for="tb in TABS" :key="tb" role="tab" :aria-selected="tab === tb" :class="['chip', { on: tab === tb }]" @click="tab = tb">
        {{ t(`review.tabs.${tb}`) }}<template v-if="tb === 'unchecked'"> · {{ counts.unchecked }}</template>
      </button>
    </div>

    <div class="chips filters">
      <select v-model="tag" class="field small" :aria-label="t('review.questionTag')">
        <option value="">{{ t('review.questionTag') }}</option>
        <option v-for="tg in allTags" :key="tg" :value="tg">{{ tg }}</option>
      </select>
      <button :class="['chip', { on: outsidePrograms }]" :aria-pressed="outsidePrograms" @click="outsidePrograms = !outsidePrograms">{{ t('review.outsidePrograms') }}</button>
      <button :class="['chip', { on: outsideCourses }]" :aria-pressed="outsideCourses" @click="outsideCourses = !outsideCourses">{{ t('review.outsideCourses') }}</button>
      <select v-model="locationId" class="field small" :aria-label="t('review.location')">
        <option value="">{{ t('review.location') }}</option>
        <option v-for="l in locations" :key="l.id" :value="l.id">{{ l.name }}</option>
      </select>
    </div>

    <p v-if="error" class="error-text">{{ error }}</p>
    <p v-if="notice" class="note teal">{{ notice }}</p>

    <div v-if="items.length === 0" class="card muted">{{ t('review.empty') }}</div>

    <article v-for="item in items" :key="item.answerId" class="card answer">
      <header class="who">
        <span class="avatar" aria-hidden="true">{{ initials(item.fullName) }}</span>
        <div class="grow">
          <b>{{ item.fullName }}</b>
          <span class="sub">
            <template v-if="item.positionName">{{ item.positionName }} · </template>
            <template v-if="item.locationName">{{ item.locationName }} · </template>
            {{ t('review.quiz', { title: item.quizTitle }) }}
            <span v-if="item.isCorrect === null" :class="{ 'error-text': item.hoursWaiting >= 48 }"> · {{ t('review.hoursAgo', { n: item.hoursWaiting }) }}</span>
          </span>
        </div>
        <span v-for="tg in item.questionTags" :key="tg" class="badge muted">{{ tg }}</span>
        <span v-if="item.question?.isCritical" class="badge coral">{{ t('quiz.critical') }}</span>
      </header>

      <div class="q">
        <LessonBlocks v-if="item.question" :blocks="item.question.stem" :blocks-state="{}" readonly />
      </div>
      <p class="text">{{ answerText(item.answer) }}</p>
      <div v-if="item.files.length" class="files">
        <a v-for="f in item.files" :key="f.mediaId" :href="mediaUrls[f.mediaId]" target="_blank" rel="noopener" class="file">
          <img v-if="f.kind === 'photo' && mediaUrls[f.mediaId]" :src="mediaUrls[f.mediaId]" :alt="f.name">
          <span v-else>{{ f.name }}</span>
        </a>
      </div>

      <ul v-if="item.question?.criteria.length" class="criteria">
        <li v-for="c in item.question.criteria" :key="c">{{ c }}</li>
      </ul>

      <template v-if="item.isCorrect === null">
        <div class="grade">
          <label class="score">
            {{ t('review.score') }}
            <input v-model.number="scores[item.answerId]" type="number" min="0" :max="item.question?.points ?? 0" step="0.5" class="field num">
            {{ t('review.of', { n: item.question?.points ?? 0 }) }}
          </label>
          <button class="btn primary small" :disabled="busy === item.answerId" @click="decide(item, true)">{{ t('review.accept') }}</button>
          <button class="btn ghost small" :disabled="busy === item.answerId" @click="decide(item, false)">{{ t('review.reject') }}</button>
        </div>
        <textarea v-model="comments[item.answerId]" class="field" rows="2" :placeholder="t('review.commentHint')" :aria-label="t('review.commentHint')" />
      </template>
      <p v-else class="grade">
        <span :class="['badge', item.isCorrect ? 'passed' : 'failed']">{{ item.isCorrect ? t('review.accept') : t('review.reject') }}</span>
        <span class="sub">{{ t('review.score') }} {{ item.score }} {{ t('review.of', { n: item.question?.points ?? 0 }) }}</span>
        <span v-if="item.reviewComment" class="sub">· {{ item.reviewComment }}</span>
      </p>

      <aside v-if="item.question?.graderHint || item.question?.reference" class="hint">
        <h3>{{ t('review.graderHint') }}</h3>
        <p v-if="item.question.graderHint">{{ item.question.graderHint }}</p>
        <p v-if="item.question.reference" class="sub">{{ t('review.reference') }}: {{ item.question.reference }}</p>
      </aside>
    </article>
  </div>
</template>

<style scoped>
.filters { margin: var(--space-3) 0 var(--space-4); }
.field.small { width: auto; }
.answer { display: grid; gap: var(--space-3); margin-bottom: var(--space-3); }
.who { display: flex; align-items: center; gap: var(--space-3); flex-wrap: wrap; }
.grow { flex: 1; min-width: 0; }
.sub { display: block; font-size: var(--font-size-body-s); color: var(--color-ink-muted); }
.q { font-weight: 700; }
.text { margin: 0; background: var(--color-bg); border-radius: var(--radius-s); padding: var(--space-3); white-space: pre-wrap; }
.files { display: flex; gap: var(--space-2); flex-wrap: wrap; }
.file img { max-width: 160px; border-radius: var(--radius-s); display: block; }
.criteria { margin: 0; padding-left: var(--space-5); color: var(--color-ink-muted); font-size: var(--font-size-body-s); }
.grade { display: flex; align-items: center; gap: var(--space-2); flex-wrap: wrap; margin: 0; }
.score { display: flex; align-items: center; gap: var(--space-1); font-weight: 700; font-size: var(--font-size-body-s); margin-right: auto; }
.num { width: 72px; }
.hint { background: var(--color-bg); border-left: 3px solid var(--color-sun); border-radius: var(--radius-s); padding: var(--space-3); }
.hint h3 { margin: 0 0 var(--space-1); font-size: 12px; font-weight: 800; letter-spacing: 0.06em; text-transform: uppercase; color: var(--color-ink-faint); }
.hint p { margin: 0; }
</style>
