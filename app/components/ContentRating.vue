<script setup lang="ts">
/**
 * «Оцінок: N · середня X» — оцінка матеріалу читачем, зірка 1–5 (docs/21 §14.1, докс/33 D-042).
 * Один голос на людину: повторний клік по своїй же зірці забирає оцінку, інший — править.
 */
interface Rating { count: number, average: number | null, myValue: number | null }
const props = defineProps<{
  contentType: 'resource' | 'knowledge_article'
  contentId: string
  /** Агрегат уже прийшов разом із карткою матеріалу (докс/33 D-042) — окремого GET не робимо. */
  initial: Rating
}>()
const { t } = useI18n()
const { api } = useApi()

const rating = ref<Rating>({ ...props.initial })
const error = ref('')
const busy = ref(false)
watch(() => props.initial, v => (rating.value = { ...v }))
const avgDisplay = computed(() => rating.value.average != null ? (Math.round(rating.value.average * 10) / 10).toString() : '')

async function rate(value: number) {
  if (busy.value) return
  error.value = ''
  busy.value = true
  try {
    if (rating.value.myValue === value) rating.value = await api<Rating>(`/content-ratings/${props.contentId}`, { method: 'DELETE', query: { contentType: props.contentType } })
    else rating.value = await api<Rating>(`/content-ratings/${props.contentId}`, { method: 'PUT', body: { contentType: props.contentType, value } })
  }
  catch (err) { error.value = apiErrorOf(err).message }
  finally { busy.value = false }
}
</script>

<template>
  <div class="content-rating">
    <div class="stars" role="radiogroup" :aria-label="t('rating.rate')">
      <button
        v-for="n in 5" :key="n" type="button" role="radio"
        :aria-checked="(rating.myValue ?? 0) >= n"
        :aria-label="t('rating.stars', { n })"
        :disabled="busy"
        :class="['star', { on: (rating.myValue ?? 0) >= n }]"
        @click="rate(n)"
      >★</button>
    </div>
    <span class="summary">{{ rating.count > 0 ? t('rating.summary', { n: rating.count, avg: avgDisplay }) : t('rating.none') }}</span>
    <p v-if="error" class="error" role="alert">{{ error }}</p>
  </div>
</template>

<style scoped>
.content-rating { display: flex; align-items: center; gap: var(--space-2); flex-wrap: wrap; }
.stars { display: flex; }
.star { font: inherit; font-size: 22px; line-height: 1; background: none; border: none; cursor: pointer; color: var(--color-bg-line); padding: var(--space-1); }
.star.on { color: var(--color-sun); }
.star:disabled { cursor: default; }
.star:focus-visible { outline: 2px solid var(--color-sun); outline-offset: 2px; border-radius: var(--radius-s); }
.summary { font-size: var(--font-size-body-s); color: var(--color-ink-muted); font-weight: 700; }
.error { color: var(--color-coral-ink); margin: 0; width: 100%; }
</style>
