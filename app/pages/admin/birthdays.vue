<script setup lang="ts">
/** Дні народження (мокап Birthdays, docs/21 §14.7): чипы Майбутні · Минулі, карточки, календарь месяца, подпись про нагадування керівнику. */
definePageMeta({ layout: 'admin', middleware: 'admin-scope', requiredScope: 'people.view' })
const { t } = useI18n()
const { formatDate } = useFormat()
const { api } = useApi()
interface B { id: string, fullName: string, date: string, city: string | null, location: string | null, orgUnit: string | null, position: string | null }
const tab = ref<'upcoming' | 'past'>('upcoming')
const data = ref<{ from: string, to: string, items: B[] }>({ from: '', to: '', items: [] })
const error = ref('')
async function load() { try { data.value = await api('/birthdays', { query: { tab: tab.value } }) } catch (err) { error.value = apiErrorOf(err).message } }
watch(tab, load, { immediate: true })
const initials = (name: string) => name.split(' ').slice(0, 2).map(w => w[0] ?? '').join('').toUpperCase()
const dayWord = (iso: string) => formatDate(new Date(`${iso}T00:00:00`), { day: 'numeric', month: 'long' })
const monthStart = computed(() => { const d = new Date(`${data.value.from || new Date().toISOString().slice(0, 10)}T00:00:00`); return new Date(d.getFullYear(), d.getMonth(), 1) })
const monthName = computed(() => formatDate(monthStart.value, { month: 'long' }))
const days = computed(() => { const n = new Date(monthStart.value.getFullYear(), monthStart.value.getMonth() + 1, 0).getDate(); return Array.from({ length: n }, (_, i) => i + 1) })
const marked = computed(() => new Set(data.value.items.filter(i => i.date.slice(0, 7) === `${monthStart.value.getFullYear()}-${String(monthStart.value.getMonth() + 1).padStart(2, '0')}`).map(i => Number(i.date.slice(8, 10)))))
</script>
<template>
  <div>
    <PageHeader :title="t('birthdays.title')" :crumbs="[{ label: t('admin.section.learning') }, { label: t('admin.section.info') }, { label: t('birthdays.title') }]" />
    <p v-if="error" class="error-text" role="alert">{{ error }}</p>
    <div class="chips tabs" role="tablist">
      <button role="tab" :class="['chip', { on: tab === 'upcoming' }]" :aria-selected="tab === 'upcoming'" @click="tab = 'upcoming'">{{ t('birthdays.upcoming') }} · {{ tab === 'upcoming' ? data.items.length : '' }}</button>
      <button role="tab" :class="['chip', { on: tab === 'past' }]" :aria-selected="tab === 'past'" @click="tab = 'past'">{{ t('birthdays.past') }}</button>
      <span class="muted period">{{ t('birthdays.period', { from: data.from, to: data.to }) }}</span>
    </div>
    <div class="layout">
      <ul class="cards">
        <li v-for="b in data.items" :key="`${b.id}:${b.date}`" class="card person">
          <span class="avatar" aria-hidden="true">{{ initials(b.fullName) }}</span>
          <span class="who"><b>{{ b.fullName }}</b><span class="muted">{{ [b.position, b.location].filter(Boolean).join(' · ') }}</span></span>
          <b class="date">{{ dayWord(b.date) }}</b>
        </li>
        <li v-if="!data.items.length" class="faint">{{ t('birthdays.empty') }}</li>
      </ul>
      <aside class="card cal">
        <p class="panel-title">{{ monthName }}</p>
        <div class="grid" role="img" :aria-label="monthName">
          <span v-for="d in days" :key="d" :class="['day', { on: marked.has(d) }]">{{ d }}</span>
        </div>
        <p class="help">{{ t('birthdays.reminderHint') }}</p>
      </aside>
    </div>
  </div>
</template>
<style scoped>
.tabs { margin-bottom: var(--space-3); }
.period { font-size: var(--font-size-body-s); margin-left: auto; }
.layout { display: grid; grid-template-columns: minmax(0, 1fr) 320px; gap: var(--space-4); align-items: start; }
.cards { list-style: none; margin: 0; padding: 0; display: grid; gap: var(--space-2); }
.person { display: grid; grid-template-columns: 36px minmax(0, 1fr) auto; gap: var(--space-3); align-items: center; }
.who { display: grid; }
.who .muted { font-size: var(--font-size-body-s); }
.date { white-space: nowrap; }
.grid { display: grid; grid-template-columns: repeat(7, 1fr); gap: 4px; }
.day { display: grid; place-items: center; height: 32px; border-radius: var(--radius-s); font-size: var(--font-size-body-s); font-weight: 700; color: var(--color-ink-muted); }
.day.on { background: var(--color-sun); color: var(--color-sun-ink); }
@media (max-width: 800px) { .layout { grid-template-columns: 1fr; } }
</style>
