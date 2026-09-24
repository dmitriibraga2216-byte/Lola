<script setup lang="ts">
/** Контакти (мокап Contacts, docs/21 §14.8): фильтры Підрозділ · Посада · Місто, карточки: ПІБ, посада · точка, робочий телефон, пошта. */
const { formatShortDate } = useFormat()
definePageMeta({ layout: 'admin', middleware: 'admin-scope', requiredScope: 'people.view' })
const { t } = useI18n()
const { api } = useApi()
interface C { id: string, fullName: string, position: string | null, location: string | null, city: string | null, orgUnit: string | null, workPhone: string | null, workEmail: string | null, messenger: string | null, phone?: string | null, email?: string | null, birthDate?: string | null }
const data = ref<{ showPersonal: boolean, items: C[] }>({ showPersonal: false, items: [] })
const q = ref('')
const orgUnitId = ref('')
const positionId = ref('')
const cityId = ref('')
const units = ref<{ id: string, name: string }[]>([])
const positions = ref<{ id: string, name: string }[]>([])
const cities = ref<{ id: string, name: string }[]>([])
const error = ref('')
const initials = (name: string) => name.split(' ').slice(0, 2).map(w => w[0] ?? '').join('').toUpperCase()
async function load() {
  try { data.value = await api('/contacts', { query: { ...(q.value ? { q: q.value } : {}), ...(orgUnitId.value ? { orgUnitId: orgUnitId.value } : {}), ...(positionId.value ? { positionId: positionId.value } : {}), ...(cityId.value ? { cityId: cityId.value } : {}) } }) } catch (err) { error.value = apiErrorOf(err).message }
}
onMounted(async () => {
  try { positions.value = await api('/refs/positions'); cities.value = await api('/refs/cities'); units.value = (await api<{ units: { id: string, name: string }[] }>('/org/tree')).units ?? [] } catch { /* фильтры необязательны */ }
  await load()
})
let timer: ReturnType<typeof setTimeout>
watch(q, () => { clearTimeout(timer); timer = setTimeout(load, 300) })
watch([orgUnitId, positionId, cityId], load)
</script>
<template>
  <div>
    <PageHeader :title="t('contacts.title')" :crumbs="[{ label: t('admin.section.learning') }, { label: t('admin.section.info') }, { label: t('contacts.title') }]" />
    <p v-if="error" class="error-text" role="alert">{{ error }}</p>
    <div class="filters">
      <input v-model="q" class="field" type="search" :placeholder="t('contacts.search')" :aria-label="t('contacts.search')">
      <select v-model="orgUnitId" class="field" :aria-label="t('contacts.unit')"><option value="">{{ t('contacts.unit') }}</option><option v-for="u in units" :key="u.id" :value="u.id">{{ u.name }}</option></select>
      <select v-model="positionId" class="field" :aria-label="t('contacts.position')"><option value="">{{ t('contacts.position') }}</option><option v-for="p in positions" :key="p.id" :value="p.id">{{ p.name }}</option></select>
      <select v-model="cityId" class="field" :aria-label="t('contacts.city')"><option value="">{{ t('contacts.city') }}</option><option v-for="c in cities" :key="c.id" :value="c.id">{{ c.name }}</option></select>
    </div>
    <ul class="cards">
      <li v-for="c in data.items" :key="c.id" class="card person">
        <span class="avatar" aria-hidden="true">{{ initials(c.fullName) }}</span>
        <span class="who">
          <b>{{ c.fullName }}</b>
          <span class="muted">{{ [c.position, c.location ?? c.orgUnit].filter(Boolean).join(' · ') || '—' }}</span>
          <span v-if="c.workPhone">{{ t('contacts.work') }}: <a :href="`tel:${c.workPhone}`" class="link">{{ c.workPhone }}</a></span>
          <span v-if="c.workEmail"><a :href="`mailto:${c.workEmail}`" class="link">{{ c.workEmail }}</a></span>
          <span v-if="c.messenger" class="muted">{{ c.messenger }}</span>
          <span v-if="data.showPersonal && c.phone" class="muted">{{ t('contacts.personal') }}: {{ c.phone }}<template v-if="c.email"> · {{ c.email }}</template><template v-if="c.birthDate"> · {{ formatShortDate(new Date(c.birthDate)) }}</template></span>
        </span>
      </li>
      <li v-if="!data.items.length" class="faint">{{ t('contacts.empty') }}</li>
    </ul>
  </div>
</template>
<style scoped>
.filters { display: grid; grid-template-columns: repeat(auto-fit, minmax(160px, 1fr)); gap: var(--space-2); margin-bottom: var(--space-3); }
.cards { list-style: none; margin: 0; padding: 0; display: grid; grid-template-columns: repeat(auto-fill, minmax(280px, 1fr)); gap: var(--space-2); }
.person { display: grid; grid-template-columns: 36px minmax(0, 1fr); gap: var(--space-3); align-items: start; }
.who { display: grid; gap: 2px; font-size: var(--font-size-body-s); }
.who b { font-size: var(--font-size-body); }
</style>
