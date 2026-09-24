<script setup lang="ts">
/**
 * «Бонуси» (docs/21 §14.9, docs/04 `/me/bonuses`): баланс, «Вистачить на «…»» з мокапу Profile і
 * історія нарахувань і списань — рядки книги операцій людини з залишком після кожної. Баланс —
 * останній рядок книги, клієнт його не рахує (CLAUDE.md п. 3).
 */
definePageMeta({ layout: 'learner' })

const { t } = useI18n()
const { api } = useApi()
const { formatShortDate } = useFormat()
const bonusText = useBonusText()

type Event = 'task_completed' | 'manual' | 'purchase' | 'refund'
interface Row { id: number, delta: number, balanceAfter: number, event: Event, title: string | null, comment: string | null, createdAt: string }
interface Mine { balance: number, rating: number, affordable: { id: string, title: string, priceBonuses: number } | null, rows: Row[] }

const data = ref<Mine | null>(null)
const error = ref('')

onMounted(async () => {
  try { data.value = await api<Mine>('/me/bonuses') }
  catch (err) { error.value = apiErrorOf(err).message }
})

/** «Деталі» журналу: назва завдання чи подарунка, у ручної операції — причина. */
const headline = (r: Row) => r.title ?? r.comment ?? t(`bonuses.event.${r.event}`)
</script>

<template>
  <div>
    <div class="head">
      <NuxtLink to="/learn/profile" class="back" :aria-label="t('common.back')">
        <svg viewBox="0 0 24 24" aria-hidden="true"><path d="M19 12H6" stroke="currentColor" stroke-width="2" fill="none" stroke-linecap="round" /><path d="M11 18l-6-6 6-6" stroke="currentColor" stroke-width="2" fill="none" stroke-linecap="round" stroke-linejoin="round" /></svg>
      </NuxtLink>
      <h1>{{ t('bonuses.title') }}</h1>
    </div>
    <p v-if="error" class="error-text" role="alert">{{ error }}</p>

    <template v-if="data">
      <div class="balance">
        <svg viewBox="0 0 24 24" aria-hidden="true" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"><rect x="3.5" y="9.5" width="17" height="11" rx="1.5" /><path d="M3.5 13.5h17M12 9.5v11" /><path d="M12 9.5S9.5 4 7 5.5 9 9.5 12 9.5zM12 9.5s2.5-5.5 5-4-1 4-5 4z" /></svg>
        <div class="balance-text">
          <span class="label">{{ t('shop.available') }}</span>
          <b>{{ bonusText(data.balance) }}</b>
          <span v-if="data.affordable" class="enough">{{ t('bonuses.enough', { title: data.affordable.title }) }}</span>
        </div>
        <NuxtLink to="/learn/shop" class="btn primary small">{{ t('bonuses.shop') }}</NuxtLink>
      </div>
      <NuxtLink to="/learn/profile/study-history" class="rating">{{ t('bonuses.rating', { n: data.rating }) }}</NuxtLink>

      <h2 class="section-title">{{ t('bonuses.history') }}</h2>
      <p v-if="data.rows.length === 0" class="empty">{{ t('bonuses.empty') }}</p>
      <ul class="list">
        <li v-for="r in data.rows" :key="r.id" class="row">
          <div class="main">
            <b>{{ headline(r) }}</b>
            <span class="sub">{{ t(`bonuses.event.${r.event}`) }} · {{ formatShortDate(r.createdAt) }}</span>
            <span v-if="r.comment && r.title" class="sub">{{ r.comment }}</span>
          </div>
          <div class="amount">
            <b :class="r.delta > 0 ? 'plus' : 'minus'">{{ r.delta > 0 ? '+' : '−' }}{{ Math.abs(r.delta) }}</b>
            <span class="sub">{{ t('bonuses.after', { n: r.balanceAfter }) }}</span>
          </div>
        </li>
      </ul>
    </template>
  </div>
</template>

<style scoped>
.head { display: flex; align-items: center; gap: var(--space-3); margin: var(--space-2) 0 var(--space-3); }
.head h1 { margin: 0; font-weight: 900; font-size: var(--font-size-title-l); }
.back { display: flex; color: var(--color-ink); }
.back svg { width: 24px; height: 24px; }
.balance { display: flex; align-items: center; gap: var(--space-3); background: var(--color-sun-soft); border: 2px solid var(--color-sun); border-radius: var(--radius-m); padding: var(--space-3) var(--space-4); }
.balance svg { width: 30px; height: 30px; flex: none; color: var(--color-sun-ink); }
.balance-text { flex: 1; min-width: 0; display: grid; }
.balance .label { font-size: var(--font-size-body-s); font-weight: 700; color: var(--color-sun-ink); }
.balance b { font-size: 22px; font-weight: 900; }
.enough { font-size: var(--font-size-body-s); color: var(--color-ink-muted); overflow-wrap: anywhere; }
.rating { display: inline-block; margin: var(--space-3) 0 0; font-weight: 800; color: var(--color-teal-ink); text-decoration: none; }
.section-title { margin: var(--space-4) 0 var(--space-2); font-size: 12px; font-weight: 800; letter-spacing: 0.06em; text-transform: uppercase; color: var(--color-ink-muted); }
.list { list-style: none; margin: 0; padding: 0; display: grid; gap: var(--space-2); }
.row { display: flex; justify-content: space-between; gap: var(--space-3); background: var(--color-bg-soft); border-radius: var(--radius-m); padding: var(--space-3) var(--space-4); }
.main { display: grid; gap: var(--space-1); min-width: 0; }
.main b { overflow-wrap: anywhere; }
.amount { display: grid; justify-items: end; align-content: start; text-align: right; flex: none; }
.amount b { font-size: var(--font-size-title-l); font-weight: 900; font-variant-numeric: tabular-nums; }
.plus { color: var(--color-teal-ink); }
.minus { color: var(--color-coral-ink); }
.sub { font-size: var(--font-size-body-s); color: var(--color-ink-muted); }
.empty { color: var(--color-ink-faint); text-align: center; padding: var(--space-6) var(--space-3); }
</style>
