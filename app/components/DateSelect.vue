<script setup lang="ts">
import { daysInMonth, joinDateParts, splitIsoDate, yearRange } from '#shared/domain/dateParts'

/**
 * Дата тремя списками: день · місяць · рік (замечание 27.09). Нативный `input[type=date]`
 * в iPad Safari внутри `<label>` давал выбрать только месяц и год — списки работают везде
 * и с клавиатуры. v-model — ISO `YYYY-MM-DD` или `''`.
 */
const props = defineProps<{ modelValue: string, label: string, minYear: number, maxYear: number, invalid?: boolean, describedby?: string }>()
const emit = defineEmits<{ 'update:modelValue': [value: string] }>()
const { t, locale } = useI18n()
const uid = useId()

const parts = reactive(splitIsoDate(props.modelValue))
watch(() => props.modelValue, (v) => {
  if (v !== joinDateParts(parts)) Object.assign(parts, splitIsoDate(v))
})
watch(parts, () => {
  const v = joinDateParts(parts)
  if (v) parts.d = String(Number(v.slice(8)))
  if (v !== props.modelValue) emit('update:modelValue', v)
})

const years = computed(() => yearRange(props.minYear, props.maxYear))
const months = computed(() => {
  const f = new Intl.DateTimeFormat(locale.value, { month: 'long' })
  return Array.from({ length: 12 }, (_, i) => ({ value: String(i + 1), name: f.format(new Date(Date.UTC(2000, i, 15))) }))
})
const days = computed(() => {
  const n = parts.y && parts.m ? daysInMonth(Number(parts.y), Number(parts.m)) : 31
  return Array.from({ length: n }, (_, i) => String(i + 1))
})
</script>

<template>
  <div class="date-select" role="group" :aria-labelledby="`${uid}-l`" :aria-describedby="describedby">
    <span :id="`${uid}-l`" class="lbl">{{ label }}</span>
    <div class="row">
      <select v-model="parts.d" :aria-label="t('dateSelect.day')" :aria-invalid="invalid" class="d">
        <option value="">{{ t('dateSelect.day') }}</option>
        <option v-for="d in days" :key="d" :value="d">{{ d }}</option>
      </select>
      <select v-model="parts.m" :aria-label="t('dateSelect.month')" :aria-invalid="invalid" class="m">
        <option value="">{{ t('dateSelect.month') }}</option>
        <option v-for="m in months" :key="m.value" :value="m.value">{{ m.name }}</option>
      </select>
      <select v-model="parts.y" :aria-label="t('dateSelect.year')" :aria-invalid="invalid" class="y">
        <option value="">{{ t('dateSelect.year') }}</option>
        <option v-for="y in years" :key="y" :value="String(y)">{{ y }}</option>
      </select>
    </div>
    <slot />
  </div>
</template>

<style scoped>
.date-select { display: grid; gap: var(--space-1); min-width: 0; }
.lbl { font-size: var(--font-size-body-s); color: var(--color-ink-muted); }
.row { display: grid; grid-template-columns: 1fr 2fr 1.4fr; gap: var(--space-1); }
select { font: inherit; border: 1px solid var(--color-bg-line); border-radius: var(--radius-s); padding: var(--space-2) var(--space-1); background: var(--color-bg); color: var(--color-ink); min-width: 0; width: 100%; box-sizing: border-box; }
select[aria-invalid="true"] { border-color: var(--color-coral); }
</style>
