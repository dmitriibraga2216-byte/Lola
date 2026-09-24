<script setup lang="ts">
import { SHOP_RESERVE_DAYS } from '#shared/domain/gamification'

/**
 * «Магазин подарунків» (docs/21 §14.3, Г-21.1; docs/05 §5.14.10; мокап Shop): шапка «Вам доступно ·
 * N бонусів», вкладки «Усі» / «Придбані · N», картки із залишком і ціною. Чи можна замовити і чому
 * ні — рахує сервер (`blocked`), екран лише показує (CLAUDE.md п. 3). Стан замовлення людині —
 * «Готується» → «Можна забрати на точці» → «Видано».
 */
definePageMeta({ layout: 'learner' })

const { t } = useI18n()
const { api } = useApi()
const { formatShortDate } = useFormat()
const bonusText = useBonusText()
const route = useRoute()

type OrderBlock = 'out_of_stock' | 'limit_reached' | 'insufficient'
type OrderStatus = 'reserved' | 'ready' | 'issued' | 'cancelled'
interface Item { id: string, title: string, description: string | null, imageKey: string | null, categoryId: string | null, priceBonuses: number, stock: number | null, locationName: string | null, limitPerUser: number | null, mine: number, blocked: OrderBlock | null }
interface Showcase { balance: number, categories: { id: string, name: string }[], items: Item[], activeOrders: number }
interface Order { id: string, status: OrderStatus, priceBonuses: number, itemTitle: string, pickupLocation: string | null, reservedUntil: string, issuedAt: string | null, cancelledAt: string | null, cancelReason: string | null, cancelledBy: 'self' | 'staff' | 'system' | null, createdAt: string }

const tab = ref<'all' | 'orders'>(route.query.tab === 'orders' ? 'orders' : 'all')
const data = ref<Showcase | null>(null)
const orders = ref<Order[]>([])
const loaded = ref(false)
const categoryId = ref('')
const open = ref<Item | null>(null)
const dialog = ref<HTMLElement | null>(null)
const error = ref('')
const notice = ref('')
const busy = ref(false)

// Мокап Shop: обкладинка картки — кольорова плашка, поки товар без зображення; кольори чергуються
const TONES = ['teal', 'sun', 'coral'] as const
const toneOf = (i: number) => TONES[i % TONES.length]
const visible = computed(() => (data.value?.items ?? []).filter(i => !categoryId.value || i.categoryId === categoryId.value))
const purchased = computed(() => orders.value.filter(o => o.status !== 'cancelled').length)
const STATUS_TONE: Record<OrderStatus, string> = { reserved: 'sun', ready: 'teal', issued: 'muted', cancelled: 'coral' }
const imgSrc = (key: string) => `/api/v1/media/${key}?redirect=1&variant=320`

async function load() {
  try {
    const [s, o] = await Promise.all([api<Showcase>('/me/gift-store'), api<Order[]>('/me/gift-store/orders')])
    data.value = s
    orders.value = o
  }
  catch (err) { error.value = apiErrorOf(err).message }
  finally { loaded.value = true }
}
onMounted(load)

watch(open, (v) => { if (v) nextTick(() => dialog.value?.focus()) })

async function order(item: Item) {
  busy.value = true
  error.value = ''
  notice.value = ''
  try {
    await api(`/gift-store/items/${item.id}/order`, { method: 'POST' })
    open.value = null
    notice.value = t('shop.ordered')
    await load()
  }
  catch (err) { error.value = apiErrorOf(err).message }
  finally { busy.value = false }
}

async function cancel(o: Order) {
  if (!confirm(t('shop.cancelConfirm', { title: o.itemTitle }))) return
  busy.value = true
  error.value = ''
  try {
    await api(`/gift-store/orders/${o.id}/status`, { method: 'POST', body: { status: 'cancelled' } })
    await load()
  }
  catch (err) { error.value = apiErrorOf(err).message }
  finally { busy.value = false }
}

function blockedText(it: Item): string {
  if (it.blocked === 'insufficient') return t('shop.missing', { amount: bonusText(it.priceBonuses - (data.value?.balance ?? 0)) })
  return it.blocked ? t(`shop.blocked.${it.blocked}`) : ''
}

function cancelledText(o: Order): string {
  if (o.cancelledBy === 'staff') return t('shop.cancelledBy.staff', { reason: o.cancelReason ?? '' })
  return t(`shop.cancelledBy.${o.cancelledBy ?? 'system'}`)
}
</script>

<template>
  <div>
    <h1 class="title">{{ t('shop.title') }}</h1>

    <NuxtLink to="/learn/bonuses" class="balance">
      <svg viewBox="0 0 24 24" aria-hidden="true" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"><rect x="3.5" y="9.5" width="17" height="11" rx="1.5" /><path d="M3.5 13.5h17M12 9.5v11" /><path d="M12 9.5S9.5 4 7 5.5 9 9.5 12 9.5zM12 9.5s2.5-5.5 5-4-1 4-5 4z" /></svg>
      <span class="balance-text">
        <span class="label">{{ t('shop.available') }}</span>
        <b>{{ bonusText(data?.balance ?? 0) }}</b>
      </span>
      <span class="history">{{ t('shop.history') }}</span>
    </NuxtLink>

    <div class="chips tabs" role="tablist">
      <button type="button" role="tab" :aria-selected="tab === 'all'" :class="['chip', { on: tab === 'all' }]" @click="tab = 'all'">{{ t('shop.tabAll') }}</button>
      <button type="button" role="tab" :aria-selected="tab === 'orders'" :class="['chip', { on: tab === 'orders' }]" @click="tab = 'orders'">
        {{ t('shop.tabOrders') }}<template v-if="purchased"> · {{ purchased }}</template>
      </button>
    </div>

    <p v-if="error" class="error-text" role="alert">{{ error }}</p>
    <p v-if="notice" class="note teal" role="status">{{ notice }}</p>

    <template v-if="tab === 'all'">
      <div v-if="(data?.categories.length ?? 0) > 1" class="chips cats">
        <button type="button" :class="['chip', { on: !categoryId }]" @click="categoryId = ''">{{ t('shop.allCategories') }}</button>
        <button v-for="c in data?.categories ?? []" :key="c.id" type="button" :class="['chip', { on: categoryId === c.id }]" @click="categoryId = c.id">{{ c.name }}</button>
      </div>
      <p v-if="loaded && visible.length === 0" class="empty">{{ t('shop.empty') }}</p>
      <div class="grid">
        <button v-for="(it, i) in visible" :key="it.id" type="button" :class="['item', { dim: it.blocked === 'out_of_stock' }]" :aria-label="`${it.title}, ${bonusText(it.priceBonuses)}`" @click="open = it">
          <span :class="['cover', toneOf(i)]">
            <img v-if="it.imageKey" :src="imgSrc(it.imageKey)" alt="" loading="lazy">
            <span v-if="it.stock !== null" class="stock">{{ it.stock }}</span>
          </span>
          <span class="name">{{ it.title }}</span>
          <span class="price">{{ bonusText(it.priceBonuses) }}</span>
        </button>
      </div>
    </template>

    <template v-else>
      <p v-if="loaded && orders.length === 0" class="empty">{{ t('shop.emptyOrders') }}</p>
      <ul class="orders">
        <li v-for="o in orders" :key="o.id" class="order">
          <div class="order-head">
            <b>{{ o.itemTitle }}</b>
            <span :class="['badge', STATUS_TONE[o.status]]">{{ t(`shop.status.${o.status}`) }}</span>
          </div>
          <p class="meta">{{ bonusText(o.priceBonuses) }} · {{ formatShortDate(o.createdAt) }}</p>
          <p v-if="o.status === 'reserved' || o.status === 'ready'" class="meta">
            {{ o.pickupLocation ? t('shop.pickupAt', { place: o.pickupLocation }) : t('shop.pickupAny') }} · {{ t('shop.reservedUntil', { date: formatShortDate(o.reservedUntil) }) }}
          </p>
          <p v-else-if="o.status === 'issued' && o.issuedAt" class="meta">{{ t('shop.issuedOn', { date: formatShortDate(o.issuedAt) }) }}</p>
          <p v-else-if="o.status === 'cancelled'" class="meta">{{ cancelledText(o) }}</p>
          <button v-if="o.status === 'reserved'" type="button" class="btn ghost small" :disabled="busy" @click="cancel(o)">{{ t('shop.cancelOrder') }}</button>
        </li>
      </ul>
    </template>

    <div v-if="open" class="modal-backdrop" @click.self="open = null" @keydown.esc="open = null">
      <div ref="dialog" class="modal" role="dialog" aria-modal="true" :aria-label="open.title" tabindex="-1">
        <span v-if="open.imageKey" class="photo"><img :src="imgSrc(open.imageKey)" alt=""></span>
        <h2>{{ open.title }}</h2>
        <p v-if="open.description" class="sub">{{ open.description }}</p>
        <ul class="facts">
          <li><b>{{ bonusText(open.priceBonuses) }}</b></li>
          <li>{{ open.stock === null ? t('shop.stockUnlimited') : t('shop.stockLeft', { n: open.stock }) }}</li>
          <li>{{ open.locationName ? t('shop.pickupAt', { place: open.locationName }) : t('shop.pickupAny') }}</li>
          <li v-if="open.limitPerUser">{{ t('shop.limitPerUser', { n: open.limitPerUser }) }}</li>
        </ul>
        <p class="hint">{{ t('shop.reserveRule', { days: SHOP_RESERVE_DAYS }) }}</p>
        <p v-if="open.blocked" class="note coral">{{ blockedText(open) }}</p>
        <div class="actions">
          <button type="button" class="btn primary" :disabled="!!open.blocked || busy" @click="order(open)">{{ t('shop.order', { price: bonusText(open.priceBonuses) }) }}</button>
          <button type="button" class="btn ghost" @click="open = null">{{ t('common.close') }}</button>
        </div>
      </div>
    </div>
  </div>
</template>

<style scoped>
.title { margin: var(--space-2) 0 var(--space-3); font-size: var(--font-size-title-l); font-weight: 900; letter-spacing: -0.01em; }
.balance { display: flex; align-items: center; gap: var(--space-3); background: var(--color-sun-soft); border: 2px solid var(--color-sun); border-radius: var(--radius-m); padding: var(--space-3) var(--space-4); text-decoration: none; color: var(--color-ink); margin-bottom: var(--space-3); }
.balance svg { width: 30px; height: 30px; flex: none; color: var(--color-sun-ink); }
.balance-text { flex: 1; min-width: 0; display: grid; }
.balance .label { font-size: var(--font-size-body-s); font-weight: 700; color: var(--color-sun-ink); }
.balance b { font-size: 22px; font-weight: 900; }
.history { font-size: var(--font-size-body-s); font-weight: 800; color: var(--color-sun-ink); text-align: right; }
.tabs { margin-bottom: var(--space-3); }
.cats { margin: 0 0 var(--space-3); }
.grid { display: grid; grid-template-columns: repeat(2, minmax(0, 1fr)); gap: var(--space-3); }
.item { font: inherit; text-align: left; color: inherit; cursor: pointer; background: var(--color-bg-soft); border: 2px solid var(--color-bg-line-soft); border-radius: var(--radius-m); padding: var(--space-3); display: grid; gap: var(--space-1); align-content: start; }
.item:hover { border-color: var(--color-bg-line); }
.item.dim { opacity: 0.6; }
.cover { position: relative; display: block; height: 78px; border-radius: var(--radius-s); margin-bottom: var(--space-2); overflow: hidden; }
.cover.teal { background: var(--color-teal); }
.cover.sun { background: var(--color-sun); }
.cover.coral { background: var(--color-coral); }
.cover img { width: 100%; height: 100%; object-fit: cover; display: block; }
.stock { position: absolute; top: var(--space-2); right: var(--space-2); background: var(--color-bg-soft); border-radius: var(--radius-pill); padding: var(--space-1) var(--space-2); font-size: 11px; line-height: 1; font-weight: 900; }
.name { font-size: var(--font-size-body); font-weight: 800; line-height: 1.35; overflow-wrap: anywhere; }
.price { font-size: var(--font-size-body-s); font-weight: 900; color: var(--color-sun-ink); }
.orders { list-style: none; margin: 0; padding: 0; display: grid; gap: var(--space-2); }
.order { background: var(--color-bg-soft); border-radius: var(--radius-m); padding: var(--space-3) var(--space-4); display: grid; gap: var(--space-1); justify-items: start; }
.order-head { display: flex; justify-content: space-between; align-items: flex-start; gap: var(--space-2); width: 100%; }
.order-head b { overflow-wrap: anywhere; }
.meta { margin: 0; font-size: var(--font-size-body-s); color: var(--color-ink-muted); }
.empty { color: var(--color-ink-faint); text-align: center; padding: var(--space-6) var(--space-3); }
.modal-backdrop { position: fixed; inset: 0; background: rgba(12, 15, 20, 0.5); display: flex; align-items: flex-end; justify-content: center; padding: var(--space-3); z-index: 50; }
.modal { background: var(--color-bg); border-radius: var(--radius-l); padding: var(--space-5); max-width: 420px; width: 100%; box-sizing: border-box; display: grid; gap: var(--space-2); max-height: 90dvh; overflow-y: auto; }
.modal h2 { margin: 0; font-weight: 900; }
.modal .sub { margin: 0; color: var(--color-ink-muted); }
.photo { display: block; border-radius: var(--radius-m); overflow: hidden; max-height: 200px; }
.photo img { width: 100%; object-fit: cover; display: block; }
.facts { margin: 0; padding-left: var(--space-4); display: grid; gap: var(--space-1); }
.hint { margin: 0; font-size: var(--font-size-body-s); color: var(--color-ink-muted); }
.actions { display: flex; gap: var(--space-2); flex-wrap: wrap; margin-top: var(--space-2); }
.actions .btn { flex: 1 1 auto; justify-content: center; }
@media (min-width: 600px) {
  .grid { grid-template-columns: repeat(3, minmax(0, 1fr)); }
  .modal-backdrop { align-items: center; }
}
</style>
