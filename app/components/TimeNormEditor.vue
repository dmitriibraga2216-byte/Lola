<script setup lang="ts">
/**
 * Форма «Норма часу елемента» (docs/v2/37 §6.3): источник — «Автор» / «Авто» / «За фактом»,
 * при «Автор» — минуты (1–3600). С 20 достоверных прохождений под полем — «За фактом люди
 * витрачають {медіана} хв (вибірка {N}). Застосувати?»: одно нажатие, и медиана становится
 * нормой. Молча система норму не меняет — только эта кнопка.
 *
 * Границы и правила — `shared/domain/timeNorms.ts`, один источник с сервером; сервер
 * проверяет их сам и отвечает `422 norm.value_range`.
 */
import { authorSecondsValid } from '#shared/domain/timeNorms'
import type { ContentTimeNormSource, LearningTimeSubjectType } from '#shared/enums'
import type { TimeNorm } from '#shared/schemas/timeNorms'

const props = defineProps<{ subjectType: LearningTimeSubjectType, subjectId: string }>()
const emit = defineEmits<{ saved: [norm: TimeNorm] }>()

const { t } = useI18n()
const { api } = useApi()
const { formatNumber } = useFormat()

const norm = ref<TimeNorm | null>(null)
const source = ref<ContentTimeNormSource>('auto')
const minutes = ref<number | null>(null)
const error = ref('')
const done = ref('')
const busy = ref(false)
const uid = computed(() => `time-norm-${props.subjectType}-${props.subjectId}`)

const base = computed(() => `/content/time-norms/${props.subjectType}/${props.subjectId}`)
const mins = (s: number | null) => (s === null ? null : formatNumber(s / 60, { maximumFractionDigits: 1 }))

function fill(n: TimeNorm) {
  norm.value = n
  source.value = n.source
  minutes.value = n.authorSeconds === null ? null : Math.round(n.authorSeconds / 60)
}

async function load() {
  error.value = ''
  try { fill(await api<TimeNorm>(base.value)) }
  catch (err) { error.value = apiErrorOf(err).message }
}
onMounted(load)

async function save() {
  error.value = ''
  done.value = ''
  if (source.value === 'author' && !authorSecondsValid((minutes.value ?? 0) * 60)) {
    error.value = t('timeNorms.editor.rangeError')
    return
  }
  busy.value = true
  try {
    const body = source.value === 'author' ? { source: 'author', authorSeconds: (minutes.value ?? 0) * 60 } : { source: source.value }
    const n = await api<TimeNorm>(base.value, { method: 'PUT', body })
    fill(n)
    done.value = t('timeNorms.editor.saved')
    emit('saved', n)
  }
  catch (err) { error.value = apiErrorOf(err).message }
  finally { busy.value = false }
}

async function applyObserved() {
  error.value = ''
  done.value = ''
  busy.value = true
  try {
    const n = await api<TimeNorm>(`${base.value}/apply-observed`, { method: 'POST' })
    fill(n)
    done.value = t('timeNorms.editor.applied')
    emit('saved', n)
  }
  catch (err) { error.value = apiErrorOf(err).message }
  finally { busy.value = false }
}
</script>

<template>
  <form class="norm" :aria-labelledby="`${uid}-title`" @submit.prevent="save">
    <p :id="`${uid}-title`" class="label">{{ t('timeNorms.editor.title') }}</p>
    <fieldset class="sources" :disabled="busy || !norm">
      <legend class="label">{{ t('timeNorms.editor.source') }}</legend>
      <label><input v-model="source" type="radio" value="author"> {{ t('timeNorms.source.author') }}</label>
      <label><input v-model="source" type="radio" value="auto"> {{ t('timeNorms.source.auto') }}</label>
      <label><input v-model="source" type="radio" value="observed" :disabled="!norm?.canApplyObserved && norm?.source !== 'observed'"> {{ t('timeNorms.source.observed') }}</label>
    </fieldset>

    <label v-if="source === 'author'" class="minutes">
      <span class="label">{{ t('timeNorms.editor.planned') }}</span>
      <input v-model.number="minutes" class="field" type="number" min="1" max="3600" step="1" inputmode="numeric" :disabled="busy" required>
    </label>
    <p v-else-if="source === 'auto'" class="muted">
      {{ norm?.autoSeconds ? t('timeNorms.editor.autoValue', { n: mins(norm.autoSeconds) }) : t('timeNorms.editor.autoNone') }}
    </p>

    <div v-if="norm?.canApplyObserved" class="note sun observed">
      <span>{{ t('timeNorms.editor.observedHint', { median: mins(norm.observedSeconds), n: norm.observedSample }) }}</span>
      <button class="btn small ghost" type="button" :disabled="busy" @click="applyObserved">{{ t('timeNorms.editor.apply') }}</button>
    </div>
    <p v-else-if="source === 'observed' && norm?.source !== 'observed'" class="muted">{{ t('timeNorms.editor.observedLocked') }}</p>

    <p v-if="error" class="note coral" role="alert">{{ error }}</p>
    <p v-if="done" class="note teal" role="status">{{ done }}</p>
    <button class="btn primary small" type="submit" :disabled="busy || !norm || (source === 'observed' && !norm.canApplyObserved)">{{ t('timeNorms.editor.save') }}</button>
  </form>
</template>

<style scoped>
.norm { display: grid; gap: var(--space-3); max-width: 480px; }
.norm .label { margin: 0; }
.sources { display: flex; flex-wrap: wrap; gap: var(--space-2) var(--space-4); border: 0; padding: 0; margin: 0; }
.sources label { display: inline-flex; gap: var(--space-1); align-items: center; font-weight: 700; }
.minutes { display: grid; gap: var(--space-1); max-width: 200px; }
.observed { display: flex; flex-wrap: wrap; gap: var(--space-2); align-items: center; justify-content: space-between; }
.norm > .btn { justify-self: start; }
</style>
