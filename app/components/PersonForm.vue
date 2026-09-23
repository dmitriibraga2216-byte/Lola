<script setup lang="ts">
/** Форма человека (docs/16 §6.1): создание — с размещением, редактирование — только профиль. */
const props = defineProps<{ initial?: Record<string, unknown> | null, mode: 'create' | 'edit', busy?: boolean }>()
const emit = defineEmits<{ submit: [payload: Record<string, unknown>], cancel: [] }>()
const { t } = useI18n()
const { api } = useApi()

interface Ref { id: string, name: string }
interface Loc extends Ref { orgUnitId: string, cityId: string | null }
interface Unit { id: string, name: string, children: Unit[] }
const refs = reactive<{ cities: Ref[], levels: Ref[], positions: Ref[], locations: Loc[], tags: Ref[], units: Unit[] }>({ cities: [], levels: [], positions: [], locations: [], tags: [], units: [] })

const i = props.initial ?? {}
const wc = (i.workContacts ?? {}) as Record<string, string>
const form = reactive({
  lastName: String(i.lastName ?? ''), firstName: String(i.firstName ?? ''), middleName: String(i.middleName ?? ''), latinName: String(i.latinName ?? ''),
  phone: String(i.phone ?? ''), email: String(i.email ?? ''),
  ext: wc.ext ?? '', workEmail: wc.workEmail ?? '', messenger: wc.messenger ?? '',
  birthDate: String(i.birthDate ?? ''), gender: String(i.gender ?? ''), tags: ([...(i.tags as string[] ?? [])]).join(', '),
  cityId: String(i.cityId ?? ''), orgUnitId: '', locationId: '', positionId: '', positionLevelId: '',
  externalId: String(i.externalId ?? ''), hiredAt: String(i.hiredAt ?? ''), positionSince: String(i.positionSince ?? ''),
  comment: String(i.comment ?? ''), isBlocked: Boolean(i.isBlocked), isHidden: Boolean(i.isHidden), locale: String(i.locale ?? ''),
})
const errors = ref<Record<string, string>>({})

onMounted(async () => {
  try {
    const [cities, levels, positions, locations, tags, tree] = await Promise.all([
      api<Ref[]>('/refs/cities'), api<Ref[]>('/refs/position-levels'), api<Ref[]>('/refs/positions'), api<Loc[]>('/refs/locations'), api<Ref[]>('/refs/tags?scope=user'), api<{ units: Unit[] }>('/org/tree'),
    ])
    Object.assign(refs, { cities, levels, positions, locations, tags, units: tree.units })
  }
  catch { /* справочники не загрузились — селекты пустые */ }
})
const flatUnits = computed(() => {
  const out: { id: string, name: string, depth: number }[] = []
  const walk = (u: Unit[], depth: number) => { for (const x of u) { out.push({ id: x.id, name: x.name, depth }); walk(x.children, depth + 1) } }
  walk(refs.units, 0)
  return out
})
const unitLocations = computed(() => form.orgUnitId ? refs.locations.filter(l => l.orgUnitId === form.orgUnitId) : refs.locations)
watch(() => form.locationId, (id) => { const l = refs.locations.find(x => x.id === id); if (l && !form.cityId && l.cityId) form.cityId = l.cityId })

const today = new Date().toISOString().slice(0, 10)
function validate(): boolean {
  const e: Record<string, string> = {}
  if (!form.lastName.trim()) e.lastName = t('person.err.lastName')
  if (!form.firstName.trim()) e.firstName = t('person.err.firstName')
  if (form.latinName && !/^[A-Za-z' .-]*$/.test(form.latinName)) e.latinName = t('person.err.latin')
  if (props.mode === 'create' && !form.phone.trim()) e.phone = t('person.err.phone')
  if (form.email && !/^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(form.email)) e.email = t('person.err.email')
  if (form.birthDate) {
    const d = new Date(form.birthDate)
    if (!(d > new Date('1920-01-01') && d < new Date(Date.now() - 14 * 365.25 * 86_400_000))) e.birthDate = t('person.err.birthDate')
  }
  if (form.hiredAt && form.hiredAt > today) e.hiredAt = t('person.err.hiredFuture')
  if (form.hiredAt && form.positionSince && form.positionSince < form.hiredAt) e.positionSince = t('person.err.positionSince')
  if (props.mode === 'create') {
    if (!form.cityId) e.cityId = t('person.err.required')
    if (!form.orgUnitId) e.orgUnitId = t('person.err.required')
    if (!form.locationId) e.locationId = t('person.err.required')
    if (!form.positionId) e.positionId = t('person.err.required')
    const loc = refs.locations.find(l => l.id === form.locationId)
    if (loc && form.orgUnitId && loc.orgUnitId !== form.orgUnitId) e.locationId = t('person.err.locationUnit')
  }
  errors.value = e
  return Object.keys(e).length === 0
}

function submit() {
  if (!validate()) return
  const tags = form.tags.split(/[,;]/).map(s => s.trim()).filter(Boolean).slice(0, 20)
  const payload: Record<string, unknown> = {
    lastName: form.lastName.trim(), firstName: form.firstName.trim(), middleName: form.middleName.trim() || null, latinName: form.latinName.trim() || null,
    ...(form.phone.trim() ? { phone: form.phone.trim() } : {}), email: form.email.trim() || null,
    workContacts: { ...(form.ext ? { ext: form.ext } : {}), ...(form.workEmail ? { workEmail: form.workEmail } : {}), ...(form.messenger ? { messenger: form.messenger } : {}) },
    birthDate: form.birthDate || null, gender: form.gender || null, tags, cityId: form.cityId || null,
    externalId: form.externalId.trim() || null, hiredAt: form.hiredAt || null, positionSince: form.positionSince || null,
    comment: form.comment.trim() || null, isBlocked: form.isBlocked, isHidden: form.isHidden, locale: form.locale || null,
  }
  if (props.mode === 'create') payload.placement = { locationId: form.locationId, positionId: form.positionId, positionLevelId: form.positionLevelId || null, orgUnitId: form.orgUnitId || null }
  emit('submit', payload)
}
</script>

<template>
  <form class="pform" novalidate @submit.prevent="submit">
    <fieldset>
      <legend>{{ t('person.profile') }}</legend>
      <label>{{ t('person.lastName') }} *<input v-model="form.lastName" maxlength="60" required :aria-invalid="!!errors.lastName"><small v-if="errors.lastName" class="err">{{ errors.lastName }}</small></label>
      <label>{{ t('person.firstName') }} *<input v-model="form.firstName" maxlength="60" required :aria-invalid="!!errors.firstName"><small v-if="errors.firstName" class="err">{{ errors.firstName }}</small></label>
      <label>{{ t('person.middleName') }}<input v-model="form.middleName" maxlength="60"></label>
      <label>{{ t('person.latinName') }}<input v-model="form.latinName" maxlength="120" :aria-invalid="!!errors.latinName"><small v-if="errors.latinName" class="err">{{ errors.latinName }}</small></label>
      <label>{{ t('person.phone') }} <template v-if="mode === 'create'">*</template><input v-model="form.phone" type="tel" placeholder="+380" :aria-invalid="!!errors.phone"><small v-if="errors.phone" class="err">{{ errors.phone }}</small></label>
      <label>{{ t('person.email') }}<input v-model="form.email" type="email" :aria-invalid="!!errors.email"><small v-if="errors.email" class="err">{{ errors.email }}</small></label>
      <label>{{ t('person.birthDate') }}<input v-model="form.birthDate" type="date" :aria-invalid="!!errors.birthDate"><small v-if="errors.birthDate" class="err">{{ errors.birthDate }}</small></label>
      <div class="radio-group" role="radiogroup" :aria-label="t('person.gender')">
        <span class="lbl">{{ t('person.gender') }}</span>
        <label v-for="g in ['male', 'female', 'unspecified']" :key="g" class="inline"><input v-model="form.gender" type="radio" :value="g"> {{ t(`person.genders.${g}`) }}</label>
      </div>
      <label>{{ t('person.tags') }}<input v-model="form.tags" list="pf-tags" :placeholder="t('person.tagsHint')"></label>
      <datalist id="pf-tags"><option v-for="r in refs.tags" :key="r.id" :value="r.name" /></datalist>
      <label>{{ t('person.locale') }}<select v-model="form.locale"><option value="">—</option><option value="uk">Українська</option><option value="en">English</option><option value="ru">Русский</option></select></label>
    </fieldset>

    <fieldset>
      <legend>{{ t('person.workContacts') }}</legend>
      <label>{{ t('person.ext') }}<input v-model="form.ext" maxlength="20"></label>
      <label>{{ t('person.workEmail') }}<input v-model="form.workEmail" type="email"></label>
      <label>{{ t('person.messenger') }}<input v-model="form.messenger" maxlength="100"></label>
    </fieldset>

    <fieldset>
      <legend>{{ t('person.placements') }}</legend>
      <label>{{ t('person.city') }} <template v-if="mode === 'create'">*</template><select v-model="form.cityId" :aria-invalid="!!errors.cityId"><option value="">—</option><option v-for="r in refs.cities" :key="r.id" :value="r.id">{{ r.name }}</option></select><small v-if="errors.cityId" class="err">{{ errors.cityId }}</small></label>
      <template v-if="mode === 'create'">
        <label>{{ t('person.orgUnit') }} *<select v-model="form.orgUnitId" :aria-invalid="!!errors.orgUnitId"><option value="">—</option><option v-for="u in flatUnits" :key="u.id" :value="u.id">{{ '· '.repeat(u.depth) }}{{ u.name }}</option></select><small v-if="errors.orgUnitId" class="err">{{ errors.orgUnitId }}</small></label>
        <label>{{ t('person.location') }} *<select v-model="form.locationId" :aria-invalid="!!errors.locationId"><option value="">—</option><option v-for="l in unitLocations" :key="l.id" :value="l.id">{{ l.name }}</option></select><small v-if="errors.locationId" class="err">{{ errors.locationId }}</small></label>
        <label>{{ t('person.position') }} *<select v-model="form.positionId" :aria-invalid="!!errors.positionId"><option value="">—</option><option v-for="r in refs.positions" :key="r.id" :value="r.id">{{ r.name }}</option></select><small v-if="errors.positionId" class="err">{{ errors.positionId }}</small></label>
        <label>{{ t('person.level') }}<select v-model="form.positionLevelId"><option value="">—</option><option v-for="r in refs.levels" :key="r.id" :value="r.id">{{ r.name }}</option></select></label>
      </template>
      <label>{{ t('person.externalId') }}<input v-model="form.externalId" maxlength="100"></label>
      <label>{{ t('person.hiredAt') }}<input v-model="form.hiredAt" type="date" :max="today" :aria-invalid="!!errors.hiredAt"><small v-if="errors.hiredAt" class="err">{{ errors.hiredAt }}</small></label>
      <label>{{ t('person.positionSince') }}<input v-model="form.positionSince" type="date" :aria-invalid="!!errors.positionSince"><small v-if="errors.positionSince" class="err">{{ errors.positionSince }}</small></label>
    </fieldset>

    <fieldset>
      <legend>{{ t('person.comment') }}</legend>
      <label class="wide">{{ t('person.comment') }}<textarea v-model="form.comment" rows="3" maxlength="2000" /></label>
      <label class="inline"><input v-model="form.isBlocked" type="checkbox"> {{ t('person.isBlocked') }} <small class="sub">{{ t('person.isBlockedHint') }}</small></label>
      <label class="inline"><input v-model="form.isHidden" type="checkbox"> {{ t('person.isHidden') }} <small class="sub">{{ t('person.isHiddenHint') }}</small></label>
    </fieldset>

    <div class="actions">
      <button type="button" class="btn" @click="emit('cancel')">{{ t('common.cancel') }}</button>
      <button type="submit" class="btn primary" :disabled="busy">{{ t('common.save') }}</button>
    </div>
  </form>
</template>

<style scoped>
.pform { display: grid; gap: var(--space-4); }
fieldset { border: 1px solid var(--color-bg-line); border-radius: var(--radius-m); padding: var(--space-3); display: grid; grid-template-columns: repeat(auto-fill, minmax(200px, 1fr)); gap: var(--space-2) var(--space-3); margin: 0; min-width: 0; }
legend { font-weight: 800; padding: 0 var(--space-2); }
label { display: grid; gap: var(--space-1); font-size: var(--font-size-body-s); color: var(--color-ink-muted); min-width: 0; }
label.inline { display: flex; align-items: center; gap: var(--space-2); color: var(--color-ink); grid-column: 1 / -1; flex-wrap: wrap; }
label.wide { grid-column: 1 / -1; }
.radio-group { display: flex; gap: var(--space-3); align-items: center; flex-wrap: wrap; font-size: var(--font-size-body-s); color: var(--color-ink-muted); }
.radio-group .inline { grid-column: auto; }
input, select, textarea { font: inherit; border: 1px solid var(--color-bg-line); border-radius: var(--radius-s); padding: var(--space-2); background: var(--color-bg); color: var(--color-ink); min-width: 0; width: 100%; box-sizing: border-box; }
input[type="checkbox"], input[type="radio"] { width: auto; }
input[aria-invalid="true"], select[aria-invalid="true"] { border-color: var(--color-coral); }
.err { color: var(--color-coral-ink); }
.sub { color: var(--color-ink-faint); }
.actions { display: flex; gap: var(--space-2); justify-content: flex-end; flex-wrap: wrap; }
.btn { font: inherit; font-weight: 700; border: 1px solid var(--color-bg-line); background: var(--color-bg-soft); color: var(--color-ink); border-radius: var(--radius-pill); padding: var(--space-2) var(--space-4); cursor: pointer; }
.btn.primary { background: var(--color-sun); border-color: var(--color-sun); }
.btn:disabled { opacity: 0.5; }
</style>
