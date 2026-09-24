<script setup lang="ts">
/**
 * «Показати ще» под таблицей с ключевым курсором (docs/04 §4.1). Если в этом браузере включена
 * подгрузка при прокрутке (`useTableBehavior`, docs/v2/39 П-24.1), следующая страница приходит
 * сама, когда кнопка показывается на экране. Кнопка при этом остаётся — клавиатура и экранный
 * диктор листают таблицу так же, как раньше.
 */
const props = defineProps<{ loading?: boolean }>()
const emit = defineEmits<{ more: [] }>()
const { t } = useI18n()
const { autoLoad, readPreference } = useTableBehavior()
const el = ref<HTMLElement | null>(null)
let io: IntersectionObserver | null = null

function observe(): void {
  io?.disconnect()
  io = null
  if (!autoLoad.value || !el.value || typeof IntersectionObserver === 'undefined') return
  io = new IntersectionObserver((entries) => {
    if (entries.some(e => e.isIntersecting) && !props.loading) emit('more')
  }, { rootMargin: '200px' })
  io.observe(el.value)
}

onMounted(() => {
  readPreference()
  observe()
})
// Выбор переключили — наблюдение включается или снимается сразу
watch(autoLoad, observe)
// Страница догрузилась: переподписка сразу сообщает, видна ли кнопка, — короткая таблица дочитывается до конца
watch(() => props.loading, (now, before) => { if (before && !now) observe() })
onBeforeUnmount(() => io?.disconnect())
</script>

<template>
  <div ref="el" class="load-more">
    <button class="btn ghost" type="button" :disabled="loading" @click="emit('more')">{{ t('common.loadMore') }}</button>
    <span v-if="autoLoad" class="sub">{{ t('tables.autoLoadOn') }}</span>
  </div>
</template>

<style scoped>
.load-more { display: flex; align-items: center; gap: var(--space-3); flex-wrap: wrap; margin-top: var(--space-3); }
.sub { color: var(--color-ink-muted); font-size: var(--font-size-body-s); }
</style>
