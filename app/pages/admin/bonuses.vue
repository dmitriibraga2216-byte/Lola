<script setup lang="ts">
/**
 * «Журнал операцій з бонусами» і «Керування бонусами» (docs/21 §14.9; мокап Bonuses): книга з
 * залишком у рядку — ЛЮДИНА · БАЛАНС · ОПЕРАЦІЯ · ПОДІЯ · ДЕТАЛІ · ДАТА — і реєстр людей з поточною
 * кількістю бонусів. «Нарахувати вручну» — сума зі знаком і причина (docs/21 §7.5). Область —
 * як у сервера: `shop.manage` бачить мережу, наставник і керівник точки (`bonus.grant`) — своїх людей.
 */
definePageMeta({ layout: 'admin', middleware: 'admin-scope', requiredAnyScope: ['shop.manage', 'bonus.grant'] })

const { t } = useI18n()
const { apiRaw, api } = useApi()
const { hasScope } = useAuth()
const { formatShortDate } = useFormat()
const bonusText = useBonusText()
const route = useRoute()

type Tab = 'journal' | 'registry'
type Event = 'task_completed' | 'manual' | 'purchase' | 'refund'
const EVENTS: Event[] = ['task_completed', 'manual', 'purchase', 'refund']
interface Row { id: number, delta: number, balanceAfter: number, event: Event, title: string | null, comment: string | null, createdAt: string, userId: string, fullName: string, position: string | null, location: string | null, actorName: string | null }
interface Person { userId: string, fullName: string, position: string | null, location: string | null, tags: string[], balance: number }

const tab = ref<Tab>(route.query.tab === 'registry' ? 'registry' : 'journal')
const canGrant = computed(() => hasScope('bonus.grant'))
const error = ref('')
const notice = ref('')

// ── Журнал: курсор — id рядка книги ──
const rows = ref<Row[]>([])
const cursor = ref<number | null>(null)
const jq = ref('')
const event = ref<Event | ''>('')
const journalLoaded = ref(false)
async function loadJournal(more = false) {
  error.value = ''
  try {
    const r = await apiRaw<{ data: Row[], meta: { cursor: number | null } }>('/bonuses/ledger', { query: { limit: 50, ...(jq.value.trim() ? { q: jq.value.trim() } : {}), ...(event.value ? { event: event.value } : {}), ...(more && cursor.value ? { cursor: cursor.value } : {}) } })
    rows.value = more ? [...rows.value, ...r.data] : r.data
    cursor.value = r.meta.cursor
  }
  catch (err) { error.value = apiErrorOf(err).message }
  finally { journalLoaded.value = true }
}

// ── Реєстр ──
const people = ref<Person[]>([])
const total = ref(0)
const page = ref(1)
const PER_PAGE = 50
const rq = ref('')
const registryLoaded = ref(false)
const pages = computed(() => Math.max(1, Math.ceil(total.value / PER_PAGE)))
async function loadRegistry() {
  error.value = ''
  try {
    const r = await apiRaw<{ data: Person[], meta: { total: number } }>('/bonuses/balances', { query: { page: page.value, perPage: PER_PAGE, ...(rq.value.trim() ? { q: rq.value.trim() } : {}) } })
    people.value = r.data
    total.value = r.meta.total
  }
  catch (err) { error.value = apiErrorOf(err).message }
  finally { registryLoaded.value = true }
}

onMounted(() => tab.value === 'journal' ? loadJournal() : loadRegistry())
watch(tab, (v) => { notice.value = ''; if (v === 'journal' && !journalLoaded.value) loadJournal(); if (v === 'registry' && !registryLoaded.value) loadRegistry() })
let jt: ReturnType<typeof setTimeout> | undefined
watch([jq, event], () => { clearTimeout(jt); jt = setTimeout(() => loadJournal(), 300) })
let rt: ReturnType<typeof setTimeout> | undefined
watch(rq, () => { clearTimeout(rt); rt = setTimeout(() => { page.value = 1; loadRegistry() }, 300) })
watch(page, () => loadRegistry())

// ── «Нарахувати вручну» ──
const grant = reactive({ open: false, person: null as Person | null, search: '', found: [] as Person[], delta: 5, comment: '', busy: false, error: '' })
const dialog = ref<HTMLElement | null>(null)
function openGrant(person: Person | null = null) {
  Object.assign(grant, { open: true, person, search: '', found: [], delta: 5, comment: '', error: '' })
  nextTick(() => dialog.value?.focus())
}
let gt: ReturnType<typeof setTimeout> | undefined
watch(() => grant.search, (v) => {
  clearTimeout(gt)
  if (!v.trim()) { grant.found = []; return }
  gt = setTimeout(async () => {
    try { grant.found = (await apiRaw<{ data: Person[] }>('/bonuses/balances', { query: { q: v.trim(), perPage: 8 } })).data }
    catch { grant.found = [] }
  }, 300)
})
async function submitGrant() {
  if (!grant.person) return
  grant.busy = true
  grant.error = ''
  try {
    const r = await api<{ balance: number }>('/bonuses/adjust', { method: 'POST', body: { userId: grant.person.userId, delta: Number(grant.delta), comment: grant.comment.trim() } })
    notice.value = t('bonuses.granted', { name: grant.person.fullName, n: bonusText(r.balance) })
    grant.open = false
    if (journalLoaded.value) await loadJournal()
    if (registryLoaded.value) await loadRegistry()
  }
  catch (err) { grant.error = apiErrorOf(err).message }
  finally { grant.busy = false }
}

const who = (p: { position: string | null, location: string | null }) => [p.position, p.location].filter(Boolean).join(' · ')
</script>

<template>
  <div>
    <PageHeader :title="t('bonuses.journalTitle')" :crumbs="[{ label: t('admin.section.learning') }, { label: t('shop.crumb') }]">
      <template v-if="canGrant" #actions>
        <button type="button" class="btn primary" @click="openGrant()">{{ t('bonuses.grant') }}</button>
      </template>
    </PageHeader>

    <p class="help hint">{{ t('bonuses.hint') }}</p>

    <div class="chips tabs" role="tablist">
      <button type="button" role="tab" :aria-selected="tab === 'journal'" :class="['chip', { on: tab === 'journal' }]" @click="tab = 'journal'">{{ t('bonuses.tab.journal') }}</button>
      <button type="button" role="tab" :aria-selected="tab === 'registry'" :class="['chip', { on: tab === 'registry' }]" @click="tab = 'registry'">{{ t('bonuses.tab.registry') }}</button>
    </div>

    <p v-if="error" class="note coral" role="alert">{{ error }}</p>
    <p v-if="notice" class="note teal" role="status">{{ notice }}</p>

    <template v-if="tab === 'journal'">
      <div class="filters">
        <input v-model="jq" class="field" type="search" :placeholder="t('bonuses.search')" :aria-label="t('bonuses.search')">
        <select v-model="event" class="field" :aria-label="t('bonuses.col.event')">
          <option value="">{{ t('bonuses.anyEvent') }}</option>
          <option v-for="e in EVENTS" :key="e" :value="e">{{ t(`bonuses.event.${e}`) }}</option>
        </select>
      </div>
      <div class="table-wrap">
        <table class="table">
          <thead>
            <tr>
              <th>{{ t('bonuses.col.person') }}</th>
              <th class="num">{{ t('bonuses.col.balance') }}</th>
              <th class="num">{{ t('bonuses.col.operation') }}</th>
              <th>{{ t('bonuses.col.event') }}</th>
              <th>{{ t('bonuses.col.details') }}</th>
              <th>{{ t('bonuses.col.date') }}</th>
            </tr>
          </thead>
          <tbody>
            <tr v-for="r in rows" :key="r.id">
              <td>
                <NuxtLink :to="`/admin/people/${r.userId}`" class="strong-link">{{ r.fullName }}</NuxtLink>
                <span v-if="who(r)" class="sub">{{ who(r) }}</span>
              </td>
              <td class="num">{{ r.balanceAfter }}</td>
              <td :class="['num', 'delta', r.delta > 0 ? 'plus' : 'minus']">{{ r.delta > 0 ? '+' : '−' }}{{ Math.abs(r.delta) }}</td>
              <td>{{ t(`bonuses.event.${r.event}`) }}</td>
              <td>
                {{ r.title ?? r.comment ?? '—' }}
                <span v-if="r.title && r.comment" class="sub">{{ r.comment }}</span>
                <span v-if="r.actorName" class="sub">{{ t('bonuses.by', { name: r.actorName }) }}</span>
              </td>
              <td class="nowrap">{{ formatShortDate(r.createdAt) }}</td>
            </tr>
            <tr v-if="journalLoaded && rows.length === 0"><td colspan="6" class="faint">{{ t('bonuses.emptyJournal') }}</td></tr>
          </tbody>
        </table>
      </div>
      <button v-if="cursor" type="button" class="btn ghost more" @click="loadJournal(true)">{{ t('common.loadMore') }}</button>
    </template>

    <template v-else>
      <div class="filters">
        <input v-model="rq" class="field" type="search" :placeholder="t('bonuses.search')" :aria-label="t('bonuses.search')">
      </div>
      <div class="table-wrap">
        <table class="table">
          <thead>
            <tr>
              <th>{{ t('bonuses.col.person') }}</th>
              <th>{{ t('bonuses.col.position') }}</th>
              <th>{{ t('bonuses.col.location') }}</th>
              <th>{{ t('bonuses.col.tags') }}</th>
              <th class="num">{{ t('bonuses.col.current') }}</th>
              <th v-if="canGrant" />
            </tr>
          </thead>
          <tbody>
            <tr v-for="p in people" :key="p.userId">
              <td><NuxtLink :to="`/admin/people/${p.userId}`" class="strong-link">{{ p.fullName }}</NuxtLink></td>
              <td>{{ p.position ?? '—' }}</td>
              <td>{{ p.location ?? '—' }}</td>
              <td><span v-for="tag in p.tags" :key="tag" class="badge">{{ tag }}</span></td>
              <td class="num"><b>{{ p.balance }}</b></td>
              <td v-if="canGrant"><button type="button" class="btn ghost small" @click="openGrant(p)">{{ t('bonuses.grantShort') }}</button></td>
            </tr>
            <tr v-if="registryLoaded && people.length === 0"><td :colspan="canGrant ? 6 : 5" class="faint">{{ t('bonuses.emptyRegistry') }}</td></tr>
          </tbody>
        </table>
      </div>
      <div v-if="pages > 1" class="pager">
        <button type="button" class="btn ghost small" :disabled="page <= 1" :aria-label="t('common.back')" @click="page--">←</button>
        <span>{{ t('bonuses.page', { n: page, total: pages }) }}</span>
        <button type="button" class="btn ghost small" :disabled="page >= pages" :aria-label="t('common.next')" @click="page++">→</button>
      </div>
    </template>

    <div v-if="grant.open" class="overlay" @click.self="grant.open = false">
      <form ref="dialog" class="modal" role="dialog" aria-modal="true" :aria-label="t('bonuses.grantTitle')" tabindex="-1" @submit.prevent="submitGrant" @keydown.esc="grant.open = false">
        <h2>{{ t('bonuses.grantTitle') }}</h2>
        <p class="help">{{ t('bonuses.grantHint') }}</p>
        <div v-if="grant.person" class="picked">
          <b>{{ grant.person.fullName }}</b>
          <span class="sub">{{ who(grant.person) }} · {{ bonusText(grant.person.balance) }}</span>
          <button type="button" class="btn ghost small" @click="grant.person = null">{{ t('common.edit') }}</button>
        </div>
        <template v-else>
          <label class="label" for="grant-search">{{ t('bonuses.person') }}</label>
          <input id="grant-search" v-model="grant.search" class="field" type="search" autocomplete="off" :placeholder="t('bonuses.search')">
          <ul v-if="grant.found.length" class="found" role="listbox" :aria-label="t('bonuses.person')">
            <li v-for="p in grant.found" :key="p.userId">
              <button type="button" class="found-item" @click="grant.person = p">{{ p.fullName }}<span class="sub">{{ who(p) }}</span></button>
            </li>
          </ul>
        </template>
        <label class="label" for="grant-delta">{{ t('bonuses.amount') }}</label>
        <input id="grant-delta" v-model.number="grant.delta" class="field short" type="number" min="-10000" max="10000" step="1" required>
        <label class="label" for="grant-comment">{{ t('bonuses.comment') }}</label>
        <input id="grant-comment" v-model="grant.comment" class="field" minlength="3" maxlength="300" required>
        <p v-if="grant.error" class="error-text" role="alert">{{ grant.error }}</p>
        <div class="modal-actions">
          <button type="submit" class="btn primary" :disabled="grant.busy || !grant.person || !grant.delta || grant.comment.trim().length < 3">{{ t('bonuses.grantShort') }}</button>
          <button type="button" class="btn ghost" @click="grant.open = false">{{ t('common.cancel') }}</button>
        </div>
      </form>
    </div>
  </div>
</template>

<style scoped>
.hint { margin: 0 0 var(--space-3); font-weight: 700; }
.tabs { margin-bottom: var(--space-4); }
.filters { display: flex; gap: var(--space-2); flex-wrap: wrap; margin-bottom: var(--space-3); }
.filters .field { flex: 1 1 220px; max-width: 360px; }
.strong-link { font-weight: 800; color: var(--color-ink); text-decoration: none; }
.strong-link:hover { text-decoration: underline; }
.delta { font-weight: 900; }
.plus { color: var(--color-teal-ink); }
.minus { color: var(--color-coral-ink); }
.nowrap { white-space: nowrap; }
.more { margin-top: var(--space-3); }
.pager { display: flex; align-items: center; gap: var(--space-3); margin-top: var(--space-3); }
.overlay { position: fixed; inset: 0; background: rgba(12, 15, 20, 0.5); display: grid; place-items: center; padding: var(--space-3); z-index: 50; }
.modal { background: var(--color-bg-soft); border-radius: var(--radius-l); padding: var(--space-5); display: grid; gap: var(--space-2); width: min(480px, 100%); box-sizing: border-box; max-height: 90dvh; overflow-y: auto; }
.modal h2 { margin: 0; font-weight: 900; }
.field.short { max-width: 160px; }
.picked { display: flex; align-items: center; gap: var(--space-2); flex-wrap: wrap; background: var(--color-bg); border-radius: var(--radius-s); padding: var(--space-2) var(--space-3); }
.picked .sub { flex: 1 1 auto; }
.found { list-style: none; margin: 0; padding: 0; display: grid; gap: var(--space-1); }
.found-item { font: inherit; width: 100%; text-align: left; border: 1px solid var(--color-bg-line); background: var(--color-bg); border-radius: var(--radius-s); padding: var(--space-2) var(--space-3); cursor: pointer; display: grid; }
.found-item:hover { border-color: var(--color-ink); }
.sub { display: block; font-size: var(--font-size-body-s); color: var(--color-ink-muted); }
.modal-actions { display: flex; gap: var(--space-2); flex-wrap: wrap; margin-top: var(--space-2); }
</style>
