<script setup lang="ts">
/**
 * «Ви ще тут?» (docs/v2/37 §7.11 «Потолок сегмента», критерий приёмки 9): после 90 минут
 * подряд время прохождения останавливается, пока человек не подтвердит, что он здесь.
 * Без подтверждения сервер не засчитывает ни секунды (решение Р-21.12) — диалог только
 * спрашивает, решает сервер.
 *
 * Клавиатура: фокус сразу на «Продовжити», Enter и пробел её нажимают; 320 px — диалог
 * прижат к низу экрана, как остальные модалки прохождения.
 */
const props = defineProps<{ open: boolean }>()
const emit = defineEmits<{ confirm: [] }>()

const { t } = useI18n()
const button = ref<HTMLButtonElement | null>(null)

watch(() => props.open, async (v) => {
  if (!v) return
  await nextTick()
  button.value?.focus()
}, { immediate: true })
</script>

<template>
  <div
    v-if="open"
    class="backdrop"
    role="dialog"
    aria-modal="true"
    aria-labelledby="still-here-title"
    aria-describedby="still-here-hint"
  >
    <div class="dialog">
      <h2 id="still-here-title" class="head">{{ t('time.stillHereTitle') }}</h2>
      <p id="still-here-hint" class="sub">{{ t('time.stillHereHint') }}</p>
      <div class="actions">
        <button ref="button" type="button" class="btn primary" @click="emit('confirm')">{{ t('time.stillHereContinue') }}</button>
      </div>
    </div>
  </div>
</template>

<style scoped>
.backdrop { position: fixed; inset: 0; background: color-mix(in srgb, var(--color-ink) 50%, transparent); display: flex; align-items: flex-end; justify-content: center; padding: var(--space-3); z-index: 70; }
.dialog { background: var(--color-bg); border-radius: var(--radius-l); padding: var(--space-4); max-width: 420px; width: 100%; box-sizing: border-box; display: grid; gap: var(--space-2); }
.head { margin: 0; font-size: var(--font-size-title-l); font-weight: 900; }
.sub { margin: 0; color: var(--color-ink-muted); }
.actions { display: flex; justify-content: flex-end; }
.btn:focus-visible { outline: 2px solid var(--color-ink); outline-offset: 2px; }
@media (min-width: 560px) { .backdrop { align-items: center; } }
</style>
