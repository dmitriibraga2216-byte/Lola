<script setup lang="ts">
definePageMeta({ layout: 'learner' })
const { t } = useI18n()
const { api } = useApi()
interface M { id: string, kind: string, title: string, starts_at: string, ends_at: string, status: string, location: string | null, room: string | null, trainers: string[], seatsLeft: number | null, my_status: string | null, my_waitlist_position: number | null, enrollOpen: boolean, registered: number }
const items = ref<M[]>([])
const error = ref('')
const view = ref<'week' | 'month' | 'mine'>('week')
const month = ref(new Date().toISOString().slice(0, 7))
async function load() {
  const from = view.value === 'month' ? `${month.value}-01` : new Date().toISOString().slice(0, 10)
  const toD = view.value === 'month' ? new Date(new Date(`${month.value}-01`).setMonth(new Date(`${month.value}-01`).getMonth() + 1)) : new Date(Date.now() + 7 * 86_400_000)
  const q = new URLSearchParams({ from, to: toD.toISOString().slice(0, 10) })
  if (view.value === 'mine') { q.set('mine', 'true'); q.set('from', new Date(Date.now() - 30 * 86_400_000).toISOString().slice(0, 10)); q.set('to', new Date(Date.now() + 180 * 86_400_000).toISOString().slice(0, 10)) }
  try { items.value = await api<M[]>(`/meetups?${q}`) } catch (err) { error.value = apiErrorOf(err).message }
}
onMounted(load)
watch([view, month], load)
const days = computed(() => { const m = new Map<string, M[]>(); for (const it of items.value) { const d = new Date(it.starts_at).toISOString().slice(0, 10); m.set(d, [...(m.get(d) ?? []), it]) } return [...m].sort() })
const monthGrid = computed(() => {
  const first = new Date(`${month.value}-01T00:00:00`); const start = (first.getDay() + 6) % 7
  const n = new Date(first.getFullYear(), first.getMonth() + 1, 0).getDate()
  const cells: { d: number | null, key: string, n: number }[] = []
  for (let i = 0; i < start; i++) cells.push({ d: null, key: `e${i}`, n: 0 })
  for (let d = 1; d <= n; d++) { const key = `${month.value}-${String(d).padStart(2, '0')}`; cells.push({ d, key, n: items.value.filter(it => new Date(it.starts_at).toISOString().slice(0, 10) === key).length }) }
  return cells
})
const fmtT = (d: string) => new Date(d).toLocaleTimeString('uk-UA', { hour: '2-digit', minute: '2-digit' })
const fmtD = (d: string) => new Date(d).toLocaleDateString('uk-UA', { weekday: 'short', day: 'numeric', month: 'long' })
const badge = (m: M) => m.my_status === 'registered' || m.my_status === 'attended' ? t('mt.registered') : m.my_status === 'waitlist' ? t('mt.inQueue', { n: m.my_waitlist_position }) : !m.enrollOpen ? t('mt.closed') : m.seatsLeft === 0 ? t('mt.full') : m.seatsLeft != null ? t('mt.seatsLeft', { n: m.seatsLeft }) : ''
</script>
<template>
  <div>
    <div class="head"><h1>{{ t('mt.title') }}</h1><NuxtLink to="/learn/meetups/checkin" class="chip">📷 {{ t('mt.scan') }}</NuxtLink></div>
    <p v-if="error" class="error">{{ error }}</p>
    <div class="tabs">
      <button :class="['tab', { on: view === 'week' }]" @click="view = 'week'">{{ t('mt.week') }}</button>
      <button :class="['tab', { on: view === 'month' }]" @click="view = 'month'">{{ t('mt.month') }}</button>
      <button :class="['tab', { on: view === 'mine' }]" @click="view = 'mine'">{{ t('mt.mine') }}</button>
    </div>
    <template v-if="view === 'month'">
      <div class="row"><input v-model="month" type="month" class="field"></div>
      <div class="grid">
        <span v-for="d in ['Пн', 'Вт', 'Ср', 'Чт', 'Пт', 'Сб', 'Нд']" :key="d" class="dow">{{ d }}</span>
        <div v-for="c in monthGrid" :key="c.key" :class="['cell', { empty: !c.d, has: c.n }]"><span v-if="c.d">{{ c.d }}</span><b v-if="c.n">{{ c.n }}</b></div>
      </div>
    </template>
    <p v-if="items.length === 0" class="empty">{{ t('mt.empty') }}</p>
    <section v-for="[d, list] in days" :key="d" class="day">
      <h2>{{ fmtD(list[0]!.starts_at) }}</h2>
      <NuxtLink v-for="m in list" :key="m.id" :to="`/learn/meetups/${m.id}`" class="card" :data-testid="`mt-${m.id}`">
        <div class="row between"><span class="card-title">{{ m.kind === 'webinar' ? '🎥 ' : '' }}{{ m.title }}</span><span :class="['badge', m.my_status ?? '']">{{ badge(m) }}</span></div>
        <span class="sub">{{ fmtT(m.starts_at) }}–{{ fmtT(m.ends_at) }}<template v-if="m.location"> · {{ m.location }}</template><template v-if="m.room">, {{ m.room }}</template> · {{ m.trainers.join(', ') }}</span>
      </NuxtLink>
    </section>
  </div>
</template>
<style scoped>
.head { display: flex; justify-content: space-between; align-items: center; gap: var(--space-2); margin-bottom: var(--space-3); }
h1 { margin: 0; font-weight: 900; }
h2 { margin: var(--space-3) 0 var(--space-2); font-weight: 800; font-size: var(--font-size-body); color: var(--color-ink-muted); text-transform: capitalize; }
.tabs { display: flex; gap: var(--space-1); margin-bottom: var(--space-3); }
.tab { font: inherit; font-weight: 700; border: 1px solid var(--color-bg-line); background: transparent; border-radius: var(--radius-pill); padding: var(--space-1) var(--space-3); color: var(--color-ink-muted); }
.tab.on { background: var(--color-ink); color: var(--color-bg); border-color: var(--color-ink); }
.chip { font-weight: 700; border: 1px solid var(--color-bg-line); border-radius: var(--radius-pill); padding: var(--space-1) var(--space-3); color: var(--color-ink); text-decoration: none; font-size: var(--font-size-body-s); white-space: nowrap; }
.row { display: flex; gap: var(--space-2); align-items: center; }
.between { justify-content: space-between; }
.field { font: inherit; padding: var(--space-2); border: 1px solid var(--color-bg-line); border-radius: var(--radius-m); background: var(--color-bg); margin-bottom: var(--space-2); }
.grid { display: grid; grid-template-columns: repeat(7, 1fr); gap: 4px; margin-bottom: var(--space-3); }
.dow { font-size: var(--font-size-body-s); color: var(--color-ink-muted); text-align: center; }
.cell { aspect-ratio: 1; background: var(--color-bg-soft); border-radius: var(--radius-s); display: grid; place-items: center; font-size: var(--font-size-body-s); position: relative; }
.cell.empty { background: transparent; }
.cell.has { background: var(--color-sun); font-weight: 800; }
.cell b { position: absolute; right: 4px; bottom: 2px; font-size: 10px; }
.card { background: var(--color-bg-soft); border-radius: var(--radius-l); padding: var(--space-3); display: grid; gap: var(--space-1); color: inherit; text-decoration: none; margin-bottom: var(--space-2); }
.card-title { font-weight: 800; }
.sub { color: var(--color-ink-muted); font-size: var(--font-size-body-s); }
.badge { font-size: var(--font-size-body-s); font-weight: 700; border-radius: var(--radius-pill); padding: 2px var(--space-2); background: var(--color-bg); color: var(--color-ink-muted); white-space: nowrap; }
.badge.registered, .badge.attended { background: var(--color-teal); color: var(--color-teal-deep); }
.badge.waitlist { background: var(--color-sun); color: var(--color-sun-ink); }
.empty { color: var(--color-ink-muted); padding: var(--space-3); }
.error { background: var(--color-coral); color: var(--color-coral-deep); padding: var(--space-3); border-radius: var(--radius-m); }
</style>
