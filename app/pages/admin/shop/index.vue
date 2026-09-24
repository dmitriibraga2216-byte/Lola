<script setup lang="ts">
/**
 * «Магазин подарунків» в админке (docs/21 §14.3, Г-21.1; мокап ShopAdmin): чипи «Товари · N» ·
 * «До видачі · N» · «Видано» · «Скасовано» · «Категорії». Каталог і категорії — `shop.manage`;
 * керівник точки (`shop.issue`) бачить лише замовлення своєї точки: відмічає «Готово до видачі»,
 * «Видано» або скасовує з причиною — бонуси й залишок повертаються (рахує сервер).
 */
definePageMeta({ layout: 'admin', middleware: 'admin-scope', requiredAnyScope: ['shop.manage', 'shop.issue'] })

const { t } = useI18n()
const { api } = useApi()
const { hasScope } = useAuth()
const { formatShortDate } = useFormat()
const bonusText = useBonusText()
const route = useRoute()

type Tab = 'items' | 'pending' | 'issued' | 'cancelled' | 'categories'
type OrderStatus = 'reserved' | 'ready' | 'issued' | 'cancelled'
interface Item { id: string, title: string, categoryName: string | null, priceBonuses: number, stock: number | null, locationName: string | null, isActive: boolean, ordered: number, pending: number }
interface Order { id: string, status: OrderStatus, priceBonuses: number, itemTitle: string, pickupLocation: string | null, reservedUntil: string, issuedAt: string | null, cancelledAt: string | null, cancelReason: string | null, cancelledBy: 'self' | 'staff' | 'system' | null, userId: string, fullName: string, position: string | null, location: string | null, issuedByName: string | null, cancelledByName: string | null }
interface Category { id: string, name: string, itemsCount: number }

const canManage = computed(() => hasScope('shop.manage'))
const TABS = computed<Tab[]>(() => canManage.value ? ['items', 'pending', 'issued', 'cancelled', 'categories'] : ['pending', 'issued', 'cancelled'])
const initial = String(route.query.tab ?? '') as Tab
const tab = ref<Tab>(TABS.value.includes(initial) ? initial : TABS.value[0]!)

const items = ref<Item[]>([])
const orders = ref<Order[]>([])
const counts = ref<Record<'pending' | 'issued' | 'cancelled', number>>({ pending: 0, issued: 0, cancelled: 0 })
const categories = ref<Category[]>([])
const q = ref('')
const error = ref('')
const notice = ref('')
const busy = ref('')
const loaded = ref(false)

const STATUS_TONE: Record<OrderStatus, string> = { reserved: 'sun', ready: 'teal', issued: 'muted', cancelled: 'coral' }
const isOrdersTab = computed(() => tab.value === 'pending' || tab.value === 'issued' || tab.value === 'cancelled')

async function loadOrders() {
  const r = await api<{ rows: Order[], counts: typeof counts.value }>('/gift-store/orders', { query: { tab: isOrdersTab.value ? tab.value : 'pending', ...(q.value.trim() ? { q: q.value.trim() } : {}) } })
  if (isOrdersTab.value) orders.value = r.rows
  counts.value = r.counts
}

async function load() {
  error.value = ''
  try {
    const jobs: Promise<unknown>[] = [loadOrders()]
    if (canManage.value) {
      jobs.push(api<Item[]>('/gift-store/items').then((r) => { items.value = r }))
      jobs.push(api<Category[]>('/gift-store/categories').then((r) => { categories.value = r }))
    }
    await Promise.all(jobs)
  }
  catch (err) { error.value = apiErrorOf(err).message }
  finally { loaded.value = true }
}
onMounted(load)
watch(tab, () => { notice.value = ''; if (isOrdersTab.value) loadOrders().catch((err) => { error.value = apiErrorOf(err).message }) })
let timer: ReturnType<typeof setTimeout> | undefined
watch(q, () => { clearTimeout(timer); timer = setTimeout(() => loadOrders().catch((err) => { error.value = apiErrorOf(err).message }), 300) })

async function togglePublished(it: Item) {
  busy.value = it.id
  try {
    await api(`/gift-store/items/${it.id}`, { method: 'PATCH', body: { isActive: !it.isActive } })
    it.isActive = !it.isActive
  }
  catch (err) { error.value = apiErrorOf(err).message }
  finally { busy.value = '' }
}

async function setStatus(o: Order, status: 'ready' | 'issued') {
  busy.value = o.id
  error.value = ''
  try {
    await api(`/gift-store/orders/${o.id}/status`, { method: 'POST', body: { status } })
    notice.value = `${o.fullName} · ${o.itemTitle}: ${t(`shop.status.${status}`)}`
    await loadOrders()
  }
  catch (err) { error.value = apiErrorOf(err).message }
  finally { busy.value = '' }
}

// Скасування — окремим діалогом з причиною: людина побачить її поруч із поверненими бонусами
const cancelling = ref<Order | null>(null)
const cancelReason = ref('')
async function cancelOrder() {
  const o = cancelling.value
  if (!o) return
  busy.value = o.id
  error.value = ''
  try {
    await api(`/gift-store/orders/${o.id}/status`, { method: 'POST', body: { status: 'cancelled', reason: cancelReason.value } })
    notice.value = `${o.fullName} · ${o.itemTitle}: ${t('shop.status.cancelled')}`
    cancelling.value = null
    cancelReason.value = ''
    await loadOrders()
  }
  catch (err) { error.value = apiErrorOf(err).message }
  finally { busy.value = '' }
}

// Категорії — довідник тенанта (стартові засіваються, далі їх веде адміністратор)
const newCategory = ref('')
const editing = ref<string | null>(null)
const editName = ref('')
async function addCategory() {
  const name = newCategory.value.trim()
  if (!name) return
  try {
    await api('/gift-store/categories', { method: 'POST', body: { name } })
    newCategory.value = ''
    categories.value = await api<Category[]>('/gift-store/categories')
  }
  catch (err) { error.value = apiErrorOf(err).message }
}
async function saveCategory(c: Category) {
  const name = editName.value.trim()
  editing.value = null
  if (!name || name === c.name) return
  try {
    await api(`/gift-store/categories/${c.id}`, { method: 'PATCH', body: { name } })
    categories.value = await api<Category[]>('/gift-store/categories')
  }
  catch (err) { error.value = apiErrorOf(err).message }
}
async function removeCategory(c: Category) {
  if (!confirm(t('shop.deleteCategoryConfirm', { name: c.name }))) return
  try {
    await api(`/gift-store/categories/${c.id}`, { method: 'DELETE' })
    categories.value = await api<Category[]>('/gift-store/categories')
  }
  catch (err) { error.value = apiErrorOf(err).message }
}

const who = (o: Order) => [o.position, o.location].filter(Boolean).join(' · ')
const cancelNote = (o: Order) => o.cancelledBy === 'system' ? t('shop.expiredReason') : o.cancelledBy === 'self' ? t('shop.selfCancelled') : (o.cancelReason ?? '—')
</script>

<template>
  <div>
    <PageHeader :title="t('shop.title')" :crumbs="[{ label: t('admin.section.learning') }, { label: t('shop.crumb') }]">
      <template v-if="canManage" #actions>
        <NuxtLink to="/admin/shop/items/new" class="btn primary">{{ t('shop.addItem') }}</NuxtLink>
      </template>
    </PageHeader>

    <div class="chips tabs" role="tablist">
      <button v-for="k in TABS" :key="k" type="button" role="tab" :aria-selected="tab === k" :class="['chip', { on: tab === k }]" @click="tab = k">
        {{ t(`shop.tab.${k}`) }}<template v-if="k === 'items'"> · {{ items.length }}</template><template v-else-if="k === 'pending'"> · {{ counts.pending }}</template>
      </button>
    </div>

    <p v-if="error" class="note coral" role="alert">{{ error }}</p>
    <p v-if="notice" class="note teal" role="status">{{ notice }}</p>

    <!-- Товари (мокап ShopAdmin) -->
    <div v-if="tab === 'items'" class="table-wrap">
      <table class="table">
        <thead>
          <tr>
            <th>{{ t('shop.col.item') }}</th>
            <th>{{ t('shop.col.category') }}</th>
            <th class="num">{{ t('shop.col.price') }}</th>
            <th class="num">{{ t('shop.col.stock') }}</th>
            <th class="num">{{ t('shop.col.ordered') }}</th>
            <th>{{ t('shop.col.published') }}</th>
          </tr>
        </thead>
        <tbody>
          <tr v-for="it in items" :key="it.id">
            <td>
              <NuxtLink :to="`/admin/shop/items/${it.id}`" class="strong-link">{{ it.title }}</NuxtLink>
              <span class="sub">{{ it.locationName ? t('shop.pickupAt', { place: it.locationName }) : t('shop.pickupAny') }}</span>
            </td>
            <td><span v-if="it.categoryName" class="badge">{{ it.categoryName }}</span><span v-else class="faint">—</span></td>
            <td class="num">{{ it.priceBonuses }}</td>
            <td class="num">{{ it.stock ?? t('shop.stockUnlimited') }}</td>
            <td class="num">{{ it.ordered }}</td>
            <td>
              <label class="toggle">
                <input type="checkbox" :checked="it.isActive" :disabled="busy === it.id" :aria-label="`${t('shop.col.published')}: ${it.title}`" @change="togglePublished(it)">
              </label>
            </td>
          </tr>
          <tr v-if="loaded && items.length === 0"><td colspan="6" class="faint">{{ t('shop.emptyItems') }}</td></tr>
        </tbody>
      </table>
    </div>

    <!-- До видачі / Видано / Скасовано -->
    <template v-else-if="isOrdersTab">
      <input v-model="q" class="field search" type="search" :placeholder="t('shop.search')" :aria-label="t('shop.search')">
      <div class="table-wrap">
        <table class="table">
          <thead>
            <tr>
              <th>{{ t('shop.col.person') }}</th>
              <th>{{ t('shop.col.item') }}</th>
              <template v-if="tab === 'pending'">
                <th>{{ t('shop.col.pickup') }}</th>
                <th>{{ t('shop.col.state') }}</th>
                <th>{{ t('shop.col.reservedUntil') }}</th>
                <th />
              </template>
              <template v-else-if="tab === 'issued'">
                <th>{{ t('shop.col.issuedAt') }}</th>
                <th>{{ t('shop.col.issuedBy') }}</th>
              </template>
              <template v-else>
                <th>{{ t('shop.col.cancelledAt') }}</th>
                <th>{{ t('shop.col.reason') }}</th>
              </template>
            </tr>
          </thead>
          <tbody>
            <tr v-for="o in orders" :key="o.id">
              <td>
                <NuxtLink :to="`/admin/people/${o.userId}`" class="strong-link">{{ o.fullName }}</NuxtLink>
                <span v-if="who(o)" class="sub">{{ who(o) }}</span>
              </td>
              <td>{{ o.itemTitle }}<span class="sub">{{ bonusText(o.priceBonuses) }}</span></td>
              <template v-if="tab === 'pending'">
                <td>{{ o.pickupLocation ?? t('shop.anyPoint') }}</td>
                <td><span :class="['badge', STATUS_TONE[o.status]]">{{ t(`shop.status.${o.status}`) }}</span></td>
                <td class="nowrap">{{ formatShortDate(o.reservedUntil) }}</td>
                <td>
                  <div class="row-actions">
                    <button v-if="o.status === 'reserved'" type="button" class="btn ghost small" :disabled="busy === o.id" @click="setStatus(o, 'ready')">{{ t('shop.markReady') }}</button>
                    <button type="button" class="btn primary small" :disabled="busy === o.id" @click="setStatus(o, 'issued')">{{ t('shop.markIssued') }}</button>
                    <button type="button" class="btn ghost small" :disabled="busy === o.id" @click="cancelling = o; cancelReason = ''">{{ t('shop.cancel') }}</button>
                  </div>
                </td>
              </template>
              <template v-else-if="tab === 'issued'">
                <td class="nowrap">{{ o.issuedAt ? formatShortDate(o.issuedAt) : '—' }}</td>
                <td>{{ o.issuedByName ?? '—' }}</td>
              </template>
              <template v-else>
                <td class="nowrap">{{ o.cancelledAt ? formatShortDate(o.cancelledAt) : '—' }}</td>
                <td>{{ cancelNote(o) }}<span v-if="o.cancelledBy === 'staff' && o.cancelledByName" class="sub">{{ o.cancelledByName }}</span></td>
              </template>
            </tr>
            <tr v-if="loaded && orders.length === 0">
              <td :colspan="tab === 'pending' ? 6 : 4" class="faint">{{ t(tab === 'pending' ? 'shop.emptyPending' : tab === 'issued' ? 'shop.emptyIssued' : 'shop.emptyCancelled') }}</td>
            </tr>
          </tbody>
        </table>
      </div>
    </template>

    <!-- Категорії -->
    <section v-else class="categories">
      <p class="help">{{ t('shop.categoriesHint') }}</p>
      <ul class="cat-list">
        <li v-for="c in categories" :key="c.id" class="cat card tight">
          <template v-if="editing === c.id">
            <input v-model="editName" class="field" maxlength="60" :aria-label="t('shop.form.category')" @keydown.enter.prevent="saveCategory(c)" @keydown.esc="editing = null">
            <button type="button" class="btn primary small" @click="saveCategory(c)">{{ t('common.save') }}</button>
          </template>
          <template v-else>
            <span class="cat-name">{{ c.name }}<span class="sub">{{ t('shop.itemsCount', { n: c.itemsCount }) }}</span></span>
            <button type="button" class="btn ghost small" @click="editing = c.id; editName = c.name">{{ t('common.edit') }}</button>
            <button type="button" class="btn ghost small" :disabled="c.itemsCount > 0" @click="removeCategory(c)">{{ t('common.delete') }}</button>
          </template>
        </li>
      </ul>
      <form class="add-cat" @submit.prevent="addCategory">
        <input v-model="newCategory" class="field" maxlength="60" :placeholder="t('shop.newCategory')" :aria-label="t('shop.newCategory')">
        <button type="submit" class="btn ghost" :disabled="!newCategory.trim()">{{ t('shop.addCategory') }}</button>
      </form>
    </section>

    <div v-if="cancelling" class="overlay" @click.self="cancelling = null">
      <form class="modal" role="dialog" aria-modal="true" :aria-label="t('shop.cancelTitle')" @submit.prevent="cancelOrder" @keydown.esc="cancelling = null">
        <h2>{{ t('shop.cancelTitle') }}</h2>
        <p class="help">{{ cancelling.fullName }} · {{ cancelling.itemTitle }}</p>
        <p class="help">{{ t('shop.cancelHint') }}</p>
        <label class="label" for="cancel-reason">{{ t('shop.cancelReason') }}</label>
        <input id="cancel-reason" v-model="cancelReason" class="field" minlength="3" maxlength="500" required>
        <div class="modal-actions">
          <button type="submit" class="btn danger" :disabled="busy === cancelling.id || cancelReason.trim().length < 3">{{ t('shop.cancel') }}</button>
          <button type="button" class="btn ghost" @click="cancelling = null">{{ t('common.close') }}</button>
        </div>
      </form>
    </div>
  </div>
</template>

<style scoped>
.tabs { margin-bottom: var(--space-4); }
.search { max-width: 420px; margin-bottom: var(--space-3); }
.strong-link { font-weight: 800; color: var(--color-ink); text-decoration: none; }
.strong-link:hover { text-decoration: underline; }
.nowrap { white-space: nowrap; }
.row-actions { display: flex; flex-wrap: wrap; gap: var(--space-1); }
.categories { display: grid; gap: var(--space-3); max-width: 640px; }
.cat-list { list-style: none; margin: 0; padding: 0; display: grid; gap: var(--space-2); }
.cat { display: flex; align-items: center; gap: var(--space-2); flex-wrap: wrap; }
.cat .field { flex: 1 1 200px; }
.cat-name { flex: 1 1 auto; font-weight: 800; display: grid; }
.add-cat { display: flex; gap: var(--space-2); flex-wrap: wrap; }
.add-cat .field { flex: 1 1 200px; }
.overlay { position: fixed; inset: 0; background: rgba(12, 15, 20, 0.5); display: grid; place-items: center; padding: var(--space-3); z-index: 50; }
.modal { background: var(--color-bg-soft); border-radius: var(--radius-l); padding: var(--space-5); display: grid; gap: var(--space-2); width: min(460px, 100%); box-sizing: border-box; }
.modal h2 { margin: 0; font-weight: 900; }
.modal-actions { display: flex; gap: var(--space-2); flex-wrap: wrap; margin-top: var(--space-2); }
</style>
