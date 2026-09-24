<script setup lang="ts">
/**
 * Блок «Кількість днів відпустки» настроек компании (docs/v2/38 §5.4, docs/v2/39 П-24.1):
 * норма отпуска и больничного на календарный год за замовчуванням и переопределение на точке.
 * Пустое поле точки — «успадковує від компанії» (`38` §7.13): точка вправе переопределить только
 * больничный. Это справочная величина, а не кадровый учёт (`38` §7.12). Норма хранится таблицей
 * `absence_norms`, а не настройками пространства, поэтому у блока своя кнопка сохранения.
 */
const { t } = useI18n()
const { api } = useApi()

interface Overview {
  year: number
  defaults: { vacationDays: number, sickDays: number }
  tenant: { vacationDays: number | null, sickDays: number | null }
  locations: { locationId: string, name: string, vacationDays: number | null, sickDays: number | null }[]
}

const year = ref<number | null>(null)
const data = ref<Overview | null>(null)
const company = reactive({ vacationDays: '' as string | number, sickDays: '' as string | number })
const points = ref<Record<string, { vacationDays: string | number, sickDays: string | number }>>({})
const error = ref('')
const notice = ref('')
const busy = ref('')

const toNum = (v: string | number): number | null => (v === '' || v === null ? null : Number(v))

async function load() {
  error.value = ''
  try {
    const d = await api<Overview>('/absence-norms', { query: year.value ? { year: year.value } : {} })
    data.value = d
    year.value = d.year
    company.vacationDays = d.tenant.vacationDays ?? ''
    company.sickDays = d.tenant.sickDays ?? ''
    points.value = Object.fromEntries(d.locations.map(l => [l.locationId, { vacationDays: l.vacationDays ?? '', sickDays: l.sickDays ?? '' }]))
  }
  catch (err) { error.value = apiErrorOf(err).message }
}
onMounted(load)

const years = computed(() => {
  const base = new Date().getFullYear()
  return [base, base + 1]
})

async function put(body: Record<string, unknown>, key: string) {
  busy.value = key; error.value = ''; notice.value = ''
  try {
    await api('/absence-norms', { method: 'PUT', body: { year: year.value, ...body } })
    notice.value = t('absence.saved')
    await load()
  }
  catch (err) { error.value = apiErrorOf(err).message }
  finally { busy.value = '' }
}

function saveCompany() {
  return put({ scopeType: 'tenant', scopeId: null, vacationDays: toNum(company.vacationDays), sickDays: toNum(company.sickDays) }, 'tenant')
}
function savePoint(id: string) {
  const p = points.value[id]!
  return put({ scopeType: 'location', scopeId: id, vacationDays: toNum(p.vacationDays), sickDays: toNum(p.sickDays) }, id)
}
function resetPoint(id: string) {
  return put({ scopeType: 'location', scopeId: id, vacationDays: null, sickDays: null }, id)
}
const overridden = computed(() => (data.value?.locations ?? []).filter(l => l.vacationDays !== null || l.sickDays !== null).length)
</script>

<template>
  <div class="absence">
    <p class="help">{{ t('absence.hint') }}</p>
    <p v-if="error" class="error-text" role="alert">{{ error }}</p>
    <p v-if="notice" class="note teal" role="status">{{ notice }}</p>

    <label class="label" for="abs-year">{{ t('absence.year') }}</label>
    <select id="abs-year" v-model.number="year" class="field year" @change="load">
      <option v-for="y in years" :key="y" :value="y">{{ y }}</option>
    </select>

    <template v-if="data">
      <div class="nums">
        <div>
          <label class="label" for="abs-vac">{{ t('absence.vacationDays') }}</label>
          <input id="abs-vac" v-model="company.vacationDays" class="field num" type="number" min="0" max="365" step="0.5" :placeholder="String(data.defaults.vacationDays)">
        </div>
        <div>
          <label class="label" for="abs-sick">{{ t('absence.sickDays') }}</label>
          <input id="abs-sick" v-model="company.sickDays" class="field num" type="number" min="0" max="365" step="0.5" :placeholder="String(data.defaults.sickDays)">
        </div>
      </div>
      <p class="help">{{ t('absence.systemDefault', { v: data.defaults.vacationDays, s: data.defaults.sickDays }) }}</p>
      <button class="btn primary" type="button" :disabled="busy === 'tenant'" @click="saveCompany">{{ t('absence.saveCompany') }}</button>

      <h3 class="block-title">{{ t('absence.overrides', { n: overridden }) }}</h3>
      <p class="help">{{ t('absence.overridesHint') }}</p>
      <div class="table-wrap">
        <table class="table">
          <thead><tr><th>{{ t('absence.location') }}</th><th>{{ t('absence.vacationDays') }}</th><th>{{ t('absence.sickDays') }}</th><th /></tr></thead>
          <tbody>
            <tr v-for="l in data.locations" :key="l.locationId">
              <td>{{ l.name }}</td>
              <td><input v-model="points[l.locationId]!.vacationDays" class="field num" type="number" min="0" max="365" step="0.5" :placeholder="t('absence.inherits')" :aria-label="`${l.name}: ${t('absence.vacationDays')}`"></td>
              <td><input v-model="points[l.locationId]!.sickDays" class="field num" type="number" min="0" max="365" step="0.5" :placeholder="t('absence.inherits')" :aria-label="`${l.name}: ${t('absence.sickDays')}`"></td>
              <td class="actions">
                <button class="btn ghost small" type="button" :disabled="busy === l.locationId" @click="savePoint(l.locationId)">{{ t('common.save') }}</button>
                <button v-if="l.vacationDays !== null || l.sickDays !== null" class="btn ghost small" type="button" :disabled="busy === l.locationId" @click="resetPoint(l.locationId)">{{ t('absence.inherit') }}</button>
              </td>
            </tr>
          </tbody>
        </table>
      </div>
    </template>
  </div>
</template>

<style scoped>
.absence { display: grid; gap: var(--space-2); }
.nums { display: grid; grid-template-columns: repeat(auto-fill, minmax(200px, 1fr)); gap: var(--space-3); }
.num { max-width: 160px; }
.year { max-width: 160px; }
.block-title { margin: var(--space-3) 0 0; font-size: var(--font-size-body); font-weight: 800; }
.actions { display: flex; gap: var(--space-2); flex-wrap: wrap; }
</style>
