<script setup lang="ts">
import { ACTIVITY_LEVEL_KEYS, ACTIVITY_LEVELS, REVIEWER_ACTIVITY_DAYS, formatHoursMinutes, yearGrid } from '#shared/domain/activity'
import type { ActivityCell } from '#shared/domain/activity'
import { USER_ACTIVITY_KINDS } from '#shared/enums'
import type { PersonActivityDto } from '#shared/schemas/activity'

/**
 * «Активність за {рік}» (docs/v2/38-people-extensions.md §5.1): сетка недель × 7 дней, пять
 * уровней заливки бирюзой, легенда, подсказка «{дата}: {N} подій, {HH:MM} у навчанні» с
 * разбивкой по видам, селектор года, пусто / загрузка / ошибка.
 *
 * Сервер считает, клиент показывает: день — локальная дата человека (посчитана по снимку его
 * пояса при записи события), уровень — из агрегата. Здесь дни только раскладываются по неделям
 * (`yearGrid`, даты в UTC — пояс браузера не сдвигает клетку). Клавиатура: в сетку один заход
 * Tab, дальше стрелки — ←/→ неделя, ↑/↓ день; подсказка выбранной клетки читается вслух.
 */
const props = defineProps<{ personId: string }>()

const { t, te } = useI18n()
const { api } = useApi()
const { formatDate, plural } = useFormat()

const data = ref<PersonActivityDto | null>(null)
const year = ref<number | null>(null)
const loading = ref(true)
const failed = ref<'error' | 'forbidden' | null>(null)
/** Клетка, выбранная стрелками или мышью; `null` — по умолчанию (последний день с данными). */
const picked = ref<number | null>(null)
const active = ref<ActivityCell | null>(null)
/** Кнопки клеток по индексу — обычный массив, не реактивный: рендер от него не зависит. */
const cellRefs: HTMLButtonElement[] = []

async function load() {
  loading.value = true
  failed.value = null
  try {
    data.value = await api<PersonActivityDto>(`/people/${props.personId}/activity`, { query: year.value ? { year: year.value } : {} })
    year.value = data.value.year
  }
  catch (err) {
    failed.value = apiErrorOf(err).code === 'forbidden' ? 'forbidden' : 'error'
  }
  finally {
    loading.value = false
  }
}
onMounted(load)
watch(() => props.personId, () => { year.value = null; load() })

const shownYear = computed(() => year.value ?? new Date().getFullYear())
const weeks = computed(() => yearGrid(shownYear.value, data.value?.days ?? [], data.value?.window ?? {}))
/** Клетки в порядке фокуса: по колонкам (неделя за неделей), день — внутри колонки. */
const cells = computed(() => weeks.value.flat())
const empty = computed(() => !loading.value && !failed.value && !!data.value && data.value.days.length === 0)
/** Единственная клетка с `tabindex=0` (roving tabindex): выбранная или последний день с данными, иначе 1 января. */
const focusIdx = computed(() => {
  if (picked.value !== null && cells.value[picked.value]?.date) return picked.value
  const withData = cells.value.map((c, i) => (c.day ? i : -1)).filter(i => i >= 0)
  return withData.at(-1) ?? cells.value.findIndex(c => c.date)
})

const dateText = (iso: string) => formatDate(iso, { day: 'numeric', month: 'long', year: 'numeric', timeZone: 'UTC' })
const eventsText = (n: number) => t(`personActivity.events.${plural(n)}`, { n })
const kindText = (k: string) => te(`personActivity.kind.${k}`) ? t(`personActivity.kind.${k}`) : k

function cellLabel(c: ActivityCell): string {
  if (!c.date) return ''
  if (c.muted) return t('personActivity.outOfWindow', { date: dateText(c.date) })
  const d = c.day
  const head = t('personActivity.tip', { date: dateText(c.date), events: eventsText(d?.count ?? 0), time: formatHoursMinutes(d?.seconds ?? 0) })
  if (!d || !d.count) return head
  const kinds = USER_ACTIVITY_KINDS.filter(k => d.kinds[k]).map(k => `${kindText(k)}: ${d.kinds[k]}`).join(', ')
  return `${head}. ${kinds}`
}

/** Месяц над колонкой, где он начинается (первая колонка — всегда январь). */
const monthLabels = computed(() => weeks.value.map((w, i) => {
  const first = w.find(c => c.date)?.date
  if (!first) return ''
  const starts = i === 0 || w.some(c => c.date?.endsWith('-01'))
  const monthStart = w.find(c => c.date?.endsWith('-01'))?.date ?? first
  return starts ? formatDate(monthStart, { month: 'short', timeZone: 'UTC' }) : ''
}))
/** Подписи строк — понедельник, среда, пятница (как у легенды эталона). */
const weekdayLabels = computed(() => ['2026-01-05', '2026-01-07', '2026-01-09'].map(d => formatDate(d, { weekday: 'short', timeZone: 'UTC' })))

const levelClass = (c: ActivityCell) => c.date ? (c.muted ? 'muted' : `l${c.day?.level ?? 0}`) : 'void'

function focusCell(i: number) {
  const list = cells.value
  let j = Math.max(0, Math.min(list.length - 1, i))
  // Пустые клетки вне года пропускаются в сторону движения
  const step = j >= focusIdx.value ? 1 : -1
  while (list[j] && !list[j]!.date && j + step >= 0 && j + step < list.length) j += step
  if (!list[j]?.date) return
  picked.value = j
  active.value = list[j]!
  nextTick(() => cellRefs[j]?.focus())
}
function onKey(e: KeyboardEvent, i: number) {
  const moves: Record<string, number> = { ArrowRight: 7, ArrowLeft: -7, ArrowDown: 1, ArrowUp: -1 }
  const d = moves[e.key]
  if (d === undefined) return
  e.preventDefault()
  focusCell(i + d)
}
// Другой год или другой человек — выбор и подсказка сбрасываются
watch(cells, () => {
  picked.value = null
  active.value = null
})

function pickYear(e: Event) {
  year.value = Number((e.target as HTMLSelectElement).value)
  load()
}
</script>

<template>
  <section class="activity" :aria-busy="loading">
    <header class="head">
      <h2>{{ t('personActivity.title', { year: shownYear }) }}</h2>
      <label v-if="data && data.years.length > 1" class="year">
        <span class="sr-only">{{ t('personActivity.year') }}</span>
        <select :value="shownYear" :disabled="loading" @change="pickYear">
          <option v-for="y in data.years" :key="y" :value="y">{{ y }}</option>
        </select>
      </label>
    </header>

    <div v-if="failed === 'error'" class="state error" role="alert">
      <p>{{ t('personActivity.loadFailed') }}</p>
      <button type="button" class="btn" @click="load">{{ t('personActivity.retry') }}</button>
    </div>
    <p v-else-if="failed === 'forbidden'" class="state muted-text">{{ t('personActivity.forbidden') }}</p>

    <template v-else>
      <p v-if="data?.scope === 'reviewer'" class="note">{{ t('personActivity.reviewerWindow', { days: REVIEWER_ACTIVITY_DAYS }) }}</p>
      <div class="scroll">
        <div class="map" :class="{ skeleton: loading, pale: empty }">
          <div class="months" aria-hidden="true">
            <span v-for="(m, i) in monthLabels" :key="i">{{ m }}</span>
          </div>
          <div class="body">
            <div class="weekdays" aria-hidden="true">
              <span />
              <span>{{ weekdayLabels[0] }}</span>
              <span />
              <span>{{ weekdayLabels[1] }}</span>
              <span />
              <span>{{ weekdayLabels[2] }}</span>
              <span />
            </div>
            <div class="grid" role="group" :aria-label="t('personActivity.title', { year: shownYear })">
              <template v-for="(c, i) in cells" :key="c.date ?? `void-${i}`">
                <button
                  v-if="c.date && !loading"
                  :ref="el => { if (el) cellRefs[i] = el as HTMLButtonElement }"
                  type="button"
                  :data-date="c.date"
                  :class="['cell', levelClass(c)]"
                  :tabindex="i === focusIdx ? 0 : -1"
                  :aria-label="cellLabel(c)"
                  :title="cellLabel(c)"
                  @focus="active = c; picked = i"
                  @mouseenter="active = c"
                  @keydown="onKey($event, i)"
                />
                <span v-else :class="['cell', c.date ? 'l0' : 'void']" aria-hidden="true" />
              </template>
            </div>
          </div>
        </div>
      </div>

      <p v-if="empty" class="empty">{{ t('personActivity.empty', { year: shownYear }) }}</p>
      <p v-else-if="active?.date" class="tip" aria-live="polite">{{ cellLabel(active) }}</p>
      <p v-else-if="data && !loading" class="tip muted-text">
        {{ t('personActivity.totals', { days: data.totals.activeDays, events: eventsText(data.totals.events), time: formatHoursMinutes(data.totals.seconds) }) }}
      </p>

      <div class="foot">
        <ul class="legend" :aria-label="t('personActivity.legend')">
          <li v-for="l in ACTIVITY_LEVELS" :key="l"><span :class="['cell', `l${l}`]" aria-hidden="true" />{{ t(`personActivity.level.${ACTIVITY_LEVEL_KEYS[l]}`) }}</li>
        </ul>
        <p v-if="data" class="tz muted-text">{{ t('personActivity.timezone', { tz: data.timezone }) }}</p>
      </div>
    </template>
  </section>
</template>

<style scoped>
.activity { background: var(--color-bg-soft); border-radius: var(--radius-m); padding: var(--space-4); min-width: 0; display: grid; gap: var(--space-2); }
.head { display: flex; align-items: center; justify-content: space-between; gap: var(--space-2); flex-wrap: wrap; }
h2 { margin: 0; font-size: var(--font-size-body); font-weight: 900; }
.year select { font: inherit; border: 1px solid var(--color-bg-line); border-radius: var(--radius-s); padding: var(--space-1) var(--space-2); background: var(--color-bg); color: var(--color-ink); }
.sr-only { position: absolute; width: 1px; height: 1px; overflow: hidden; clip: rect(0 0 0 0); white-space: nowrap; }
/* Сетка шире узкого экрана — прокручивается внутри блока, страница поперёк не едет (320px) */
.scroll { overflow-x: auto; max-width: 100%; padding-bottom: var(--space-1); }
.map { --cell: var(--space-3); --gap: calc(var(--space-1) / 2); display: inline-grid; gap: var(--gap); }
.months { display: grid; grid-auto-flow: column; grid-auto-columns: calc(var(--cell) + var(--gap)); margin-left: calc(var(--space-6) + var(--gap)); font-size: var(--font-size-body-s); color: var(--color-ink-faint); white-space: nowrap; }
.months span { overflow: visible; }
.body { display: flex; gap: var(--gap); }
.weekdays { display: grid; grid-template-rows: repeat(7, var(--cell)); gap: var(--gap); width: var(--space-6); font-size: var(--font-size-body-s); color: var(--color-ink-faint); line-height: var(--cell); }
.grid { display: grid; grid-template-rows: repeat(7, var(--cell)); grid-auto-flow: column; grid-auto-columns: var(--cell); gap: var(--gap); }
.cell { display: inline-block; width: var(--cell); height: var(--cell); border-radius: calc(var(--space-1) / 2); border: 0; padding: 0; margin: 0; background: var(--color-bg-line-soft); }
button.cell { cursor: pointer; }
button.cell:focus-visible { outline: 2px solid var(--color-ink); outline-offset: 1px; border-radius: calc(var(--space-1) / 2); }
.cell.void { background: transparent; }
.cell.muted { background: var(--color-bg-line-soft); opacity: 0.4; cursor: default; }
/* Пять уровней бирюзы от бледного к насыщенному (§5.1) — производные токена, без своих цветов */
.cell.l0 { background: var(--color-bg-line-soft); }
.cell.l1 { background: color-mix(in srgb, var(--color-teal) 30%, var(--color-bg-soft)); }
.cell.l2 { background: color-mix(in srgb, var(--color-teal) 55%, var(--color-bg-soft)); }
.cell.l3 { background: color-mix(in srgb, var(--color-teal) 80%, var(--color-bg-soft)); }
.cell.l4 { background: var(--color-teal-ink); }
.map.skeleton .cell:not(.void), .map.pale .cell:not(.void) { opacity: 0.5; }
.tip, .empty, .note, .state p { margin: 0; font-size: var(--font-size-body-s); }
.empty { color: var(--color-ink-muted); }
.note { color: var(--color-teal-ink); font-weight: 700; }
.muted-text { color: var(--color-ink-faint); }
.state { display: flex; gap: var(--space-2); align-items: center; flex-wrap: wrap; }
.state.error { color: var(--color-coral-ink); }
.btn { font: inherit; font-weight: 700; border: 1px solid var(--color-bg-line); background: var(--color-bg-soft); color: var(--color-ink); border-radius: var(--radius-pill); padding: var(--space-1) var(--space-4); cursor: pointer; }
.foot { display: flex; justify-content: space-between; align-items: center; gap: var(--space-2); flex-wrap: wrap; }
.legend { list-style: none; margin: 0; padding: 0; display: flex; gap: var(--space-3); flex-wrap: wrap; font-size: var(--font-size-body-s); color: var(--color-ink-muted); }
.legend li { display: flex; align-items: center; gap: var(--space-1); }
.tz { margin: 0; font-size: var(--font-size-body-s); }
</style>
