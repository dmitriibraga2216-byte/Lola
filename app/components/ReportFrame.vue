<script setup lang="ts">
/**
 * Единый каркас отчётов и журналов (docs/22 §13.3): левая часть таблицы одинакова везде —
 * ПІБ · Посада · Місто · Підрозділ · Мітки · Призначено · Завершено · Стан · Результат.
 * `part="head"` рисует заголовки, `part="cells"` — ячейки строки; `tail=false` — только человек (журналы без прохождения).
 * Компонент возвращает фрагмент из <th>/<td>, поэтому вставляется прямо внутрь <tr>.
 */
export interface FrameRow {
  user_id?: string
  full_name?: string | null
  user_status?: string | null
  position?: string | null
  city?: string | null
  unit?: string | null
  location?: string | null
  tags?: string[] | string | null
  assigned_at?: string | Date | null
  completed_at?: string | Date | null
  status?: string | null
  result?: number | null
}
const props = withDefaults(defineProps<{ part: 'head' | 'cells', row?: FrameRow, tail?: boolean }>(), { tail: true, row: () => ({}) })
const { t } = useI18n()
const { formatShortDate } = useFormat()
const tags = computed(() => Array.isArray(props.row.tags) ? props.row.tags : typeof props.row.tags === 'string' && props.row.tags ? props.row.tags.split(',').map(s => s.trim()) : [])
const dateOf = (v: unknown) => {
  if (!v) return '—'
  const d = v instanceof Date ? v : new Date(String(v).replace(' ', 'T').replace(/([+-]\d{2})$/, '$1:00'))
  return Number.isNaN(d.getTime()) ? '—' : formatShortDate(d)
}
const STATUSES = ['not_assigned', 'not_started', 'in_progress', 'done', 'failed']
</script>

<template>
  <template v-if="part === 'head'">
    <th>{{ t('frame.col.full_name') }}</th>
    <th>{{ t('frame.col.position') }}</th>
    <th>{{ t('frame.col.city') }}</th>
    <th>{{ t('frame.col.unit') }}</th>
    <th>{{ t('frame.col.tags') }}</th>
    <template v-if="tail">
      <th>{{ t('frame.col.assigned_at') }}</th>
      <th>{{ t('frame.col.completed_at') }}</th>
      <th>{{ t('frame.col.status') }}</th>
      <th class="num">{{ t('frame.col.result') }}</th>
    </template>
  </template>
  <template v-else>
    <td class="person">
      <strong>{{ row.full_name ?? '—' }}</strong>
      <span v-if="row.user_status && row.user_status !== 'active'" class="sub">{{ t(`frame.userStatus.${row.user_status}`) }}</span>
    </td>
    <td>{{ row.position ?? '—' }}</td>
    <td>{{ row.city ?? '—' }}</td>
    <td>{{ row.unit ?? row.location ?? '—' }}<span v-if="row.unit && row.location && row.unit !== row.location" class="sub">{{ row.location }}</span></td>
    <td><div class="tags"><span v-for="tag in tags" :key="tag" class="badge muted">{{ tag }}</span><span v-if="!tags.length">—</span></div></td>
    <template v-if="tail">
      <td>{{ dateOf(row.assigned_at) }}</td>
      <td>{{ dateOf(row.completed_at) }}</td>
      <td><span v-if="row.status" :class="['badge', 'upper', STATUSES.includes(row.status) ? row.status : 'muted']">{{ STATUSES.includes(row.status) ? t(`enrollment.${row.status}`) : row.status }}</span><span v-else>—</span></td>
      <td class="num">{{ row.result == null ? '—' : `${row.result}%` }}</td>
    </template>
  </template>
</template>

<style scoped>
.person { min-width: 160px; }
.person strong { display: block; }
.tags { display: flex; flex-wrap: wrap; gap: var(--space-1); }
.sub { display: block; font-size: var(--font-size-body-s); color: var(--color-ink-faint); }
.num { text-align: right; font-variant-numeric: tabular-nums; }
</style>
