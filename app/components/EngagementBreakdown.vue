<script setup lang="ts">
import { ENGAGEMENT_BASE_MAX, ENGAGEMENT_BONUS_MAX, ENGAGEMENT_CAP } from '#shared/domain/engagementIndex'
import type { EngagementView } from '#shared/domain/engagementIndex'

/**
 * «Звідки взявся мій відсоток» (docs/v2/38-people-extensions.md §5.3, §7.2–§7.3; PR-35):
 * крупная цифра індексу залученості, дата расчёта, окно, четыре карточки с подставленными
 * числами формулы, «Разом: {total} % (максимум 130 %)», плашка «Показник довідковий…» и своя
 * динамика за 12 месяцев. Числа — из снимка (`breakdown`), экран их не пересчитывает.
 *
 * Один компонент на два экрана: свой индекс (`/learn/profile/rating`) и чужой в карточке
 * (`/admin/people/:id/rating`, носителю `person.rating.view_others`). Места в ранжированном
 * списке, «топа» и «антитопа» здесь нет ни для кого (§7.3).
 */
const props = defineProps<{ personId: string }>()

const { t } = useI18n()
const { api } = useApi()
const { formatShortDate, formatDate, formatNumber } = useFormat()

const data = ref<EngagementView | null>(null)
const loading = ref(true)
const failed = ref<'error' | 'forbidden' | 'not_found' | null>(null)
const busy = ref(false)
const notice = ref('')
const recalcError = ref('')

async function load() {
  loading.value = true
  failed.value = null
  try { data.value = await api<EngagementView>(`/people/${props.personId}/rating`) }
  catch (err) {
    const code = apiErrorOf(err).code
    failed.value = code === 'forbidden' ? 'forbidden' : code === 'not_found' ? 'not_found' : 'error'
  }
  finally { loading.value = false }
}
onMounted(load)
watch(() => props.personId, load)

async function recalc() {
  busy.value = true
  notice.value = ''
  recalcError.value = ''
  try {
    data.value = await api<EngagementView>(`/people/${props.personId}/rating/recalc`, { method: 'POST' })
    notice.value = t('engagement.recalcDone')
  }
  catch (err) { recalcError.value = apiErrorOf(err).message }
  finally { busy.value = false }
}

const num = (v: number | null | undefined) => (v === null || v === undefined ? '—' : formatNumber(v, { maximumFractionDigits: 1 }))
const date = (iso: string | null | undefined) => (iso ? formatShortDate(new Date(iso)) : '—')
const b = computed(() => data.value?.breakdown ?? null)
const earlyPct = computed(() => (b.value?.early.avg_share === null || b.value?.early.avg_share === undefined ? null : b.value.early.avg_share * 100))
const monthLabel = (month: string) => formatDate(new Date(`${month}-01T12:00:00Z`), { month: 'short', year: '2-digit' })
const barWidth = (total: number) => `${Math.max(2, Math.round((total / ENGAGEMENT_CAP) * 100))}%`
const statusText = (s: string) => t(`engagement.status.${['done', 'in_progress', 'failed', 'not_started'].includes(s) ? s : 'other'}`)
</script>

<template>
  <section class="engagement" :aria-busy="loading">
    <div v-if="loading && !data" class="skeleton" aria-hidden="true"><span /><span /><span /></div>
    <p v-else-if="failed === 'forbidden'" class="state">{{ t('engagement.forbidden') }}</p>
    <p v-else-if="failed === 'not_found'" class="state">{{ t('engagement.notFound') }}</p>
    <div v-else-if="failed === 'error'" class="state error" role="alert">
      <p>{{ t('engagement.loadFailed') }}</p>
      <button type="button" class="btn" @click="load">{{ t('engagement.retry') }}</button>
    </div>

    <template v-else-if="data">
      <header class="head">
        <h1>{{ data.self ? t('engagement.titleSelf') : t('engagement.titleOther', { name: data.person.fullName }) }}</h1>
        <p class="what">{{ t('engagement.whatItIs') }}</p>
      </header>

      <div class="hero">
        <p :class="['big', { stale: data.stale }]" data-testid="engagement-total">{{ data.total === null ? '—' : t('engagement.value', { value: num(data.total) }) }}</p>
        <div class="meta">
          <p v-if="data.calcDate">{{ t('engagement.calcDate', { date: date(data.calcDate) }) }}</p>
          <p v-if="data.window">{{ t('engagement.window', { from: date(data.window.from), to: date(data.window.to) }) }}</p>
          <p v-if="data.stale" class="warn">{{ t('engagement.stale') }}</p>
        </div>
        <button type="button" class="btn small" :disabled="busy" @click="recalc">{{ t('engagement.recalc') }}</button>
      </div>
      <p v-if="notice" class="notice" role="status">{{ notice }}</p>
      <p v-if="recalcError" class="error" role="alert">{{ recalcError }}</p>
      <p v-if="data.formula.changedAt" class="note">{{ t('engagement.formulaChanged', { date: date(data.formula.changedAt) }) }}</p>

      <p v-if="data.state === 'no_assignments'" class="state">{{ data.self ? t('engagement.emptySelf') : t('engagement.emptyOther') }}</p>
      <p v-else-if="data.state === 'pending'" class="state">{{ t('engagement.pending') }}</p>

      <template v-if="data.state === 'ok' && b && data.bonuses">
        <ol class="parts">
          <li class="part">
            <h2>{{ t('engagement.base', { value: num(data.base), max: ENGAGEMENT_BASE_MAX }) }}</h2>
            <p>{{ t('engagement.baseText', { a: num(b.base.weighted_done), b: num(b.base.weighted_total) }) }}</p>
            <details>
              <summary>{{ t('engagement.baseItems', { n: b.base.items.length }) }}</summary>
              <ul class="items">
                <li v-for="it in b.base.items" :key="it.enrollmentId">
                  <span class="title">{{ it.title }}</span>
                  <span class="sub">{{ it.mandatory ? t('engagement.mandatory') : t('engagement.voluntary') }} · {{ statusText(it.status) }}</span>
                  <b>{{ t('engagement.contribution', { value: num(it.contribution), max: it.weight }) }}</b>
                </li>
              </ul>
            </details>
          </li>
          <li class="part">
            <h2>{{ t('engagement.early', { value: num(data.bonuses.early), max: ENGAGEMENT_BONUS_MAX }) }}</h2>
            <p v-if="earlyPct !== null">{{ data.self ? t('engagement.earlyTextSelf', { d: num(earlyPct) }) : t('engagement.earlyTextOther', { d: num(earlyPct) }) }}</p>
            <p v-else>{{ t('engagement.earlyNone') }}</p>
          </li>
          <li class="part">
            <h2>{{ t('engagement.streak', { value: num(data.bonuses.streak), max: ENGAGEMENT_BONUS_MAX }) }}</h2>
            <p>{{ t('engagement.streakText', { n: b.streak.longest, target: b.streak.target }) }}</p>
          </li>
          <li class="part">
            <h2>{{ t('engagement.help', { value: num(data.bonuses.help), max: ENGAGEMENT_BONUS_MAX }) }}</h2>
            <p>{{ t('engagement.helpText', { k: b.help.credited, target: b.help.target }) }}</p>
          </li>
        </ol>
        <p class="total">{{ t('engagement.total', { total: num(data.total), cap: ENGAGEMENT_CAP }) }}</p>
      </template>

      <p class="plaque">{{ t('engagement.plaque') }}</p>
      <p class="sub">{{ t('engagement.notPoints') }}</p>

      <section class="history">
        <h2>{{ t('engagement.history') }}</h2>
        <ul v-if="data.history.length" class="bars">
          <li v-for="h in data.history" :key="h.month">
            <span class="month">{{ monthLabel(h.month) }}</span>
            <span class="track"><span class="fill" :style="{ width: barWidth(h.total) }" /></span>
            <span class="v">{{ t('engagement.value', { value: num(h.total) }) }}</span>
          </li>
        </ul>
        <p v-else class="sub">{{ t('engagement.historyEmpty') }}</p>
      </section>
    </template>
  </section>
</template>

<style scoped>
.engagement { display: grid; gap: var(--space-3); max-width: 760px; }
.head h1 { margin: 0; font-weight: 900; }
.what { margin: var(--space-1) 0 0; color: var(--color-ink-muted); font-size: var(--font-size-body-s); }
.hero { display: flex; align-items: center; gap: var(--space-4); flex-wrap: wrap; background: var(--color-bg-soft); border-radius: var(--radius-m); padding: var(--space-4); }
.big { margin: 0; font-size: var(--font-size-display); font-weight: 900; color: var(--color-teal-ink); line-height: 1; }
.big.stale { color: var(--color-ink-faint); }
.meta p { margin: 0; color: var(--color-ink-muted); font-size: var(--font-size-body-s); }
.meta .warn { color: var(--color-sun-ink); font-weight: 700; }
.hero .btn { margin-left: auto; }
.parts { list-style: none; margin: 0; padding: 0; display: grid; grid-template-columns: repeat(auto-fit, minmax(240px, 1fr)); gap: var(--space-3); }
.part { background: var(--color-bg-soft); border-radius: var(--radius-m); padding: var(--space-4); min-width: 0; display: grid; gap: var(--space-2); align-content: start; }
.part h2 { margin: 0; font-size: var(--font-size-body); font-weight: 900; }
.part p { margin: 0; color: var(--color-ink-muted); }
details summary { cursor: pointer; color: var(--color-teal-ink); font-weight: 700; font-size: var(--font-size-body-s); }
.items { list-style: none; margin: var(--space-2) 0 0; padding: 0; display: grid; gap: var(--space-1); }
.items li { display: grid; grid-template-columns: 1fr auto; gap: 0 var(--space-2); font-size: var(--font-size-body-s); }
.items .title { overflow-wrap: anywhere; }
.items .sub { grid-column: 1; }
.items b { grid-column: 2; grid-row: 1 / span 2; align-self: center; white-space: nowrap; }
.total { margin: 0; font-weight: 900; font-size: var(--font-size-title-l); }
.plaque { margin: 0; background: var(--color-sun-soft); border-radius: var(--radius-m); padding: var(--space-3); color: var(--color-ink); }
.note { margin: 0; background: var(--color-bg-line-soft); border-radius: var(--radius-m); padding: var(--space-2) var(--space-3); }
.history { background: var(--color-bg-soft); border-radius: var(--radius-m); padding: var(--space-4); }
.history h2 { margin: 0 0 var(--space-2); font-size: var(--font-size-body); color: var(--color-ink-muted); }
.bars { list-style: none; margin: 0; padding: 0; display: grid; gap: var(--space-1); }
.bars li { display: grid; grid-template-columns: 64px 1fr 72px; gap: var(--space-2); align-items: center; font-size: var(--font-size-body-s); }
.track { display: block; height: 10px; border-radius: var(--radius-pill); background: var(--color-bg-line-soft); overflow: hidden; }
.fill { display: block; height: 100%; background: var(--color-teal); border-radius: var(--radius-pill); }
.v { text-align: right; font-weight: 700; }
.state { margin: 0; color: var(--color-ink-muted); background: var(--color-bg-soft); border-radius: var(--radius-m); padding: var(--space-4); }
.state.error { color: var(--color-coral-ink); display: flex; gap: var(--space-2); align-items: center; flex-wrap: wrap; }
.state.error p { margin: 0; }
.sub { margin: 0; color: var(--color-ink-faint); font-size: var(--font-size-body-s); }
.notice { margin: 0; color: var(--color-teal-ink); }
.error { margin: 0; color: var(--color-coral-ink); }
.btn { font: inherit; font-weight: 700; border: 1px solid var(--color-bg-line); background: var(--color-bg-soft); color: var(--color-ink); border-radius: var(--radius-pill); padding: var(--space-1) var(--space-4); cursor: pointer; }
.btn.small { font-size: var(--font-size-body-s); }
.btn:disabled { opacity: 0.5; }
.skeleton { display: grid; gap: var(--space-2); }
.skeleton span { display: block; height: 72px; border-radius: var(--radius-m); background: var(--color-bg-line-soft); }
@media (max-width: 400px) { .bars li { grid-template-columns: 48px 1fr 56px; } .hero .btn { margin-left: 0; } }
</style>
