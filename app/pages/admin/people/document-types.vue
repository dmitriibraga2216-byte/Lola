<script setup lang="ts">
/**
 * Справочник типов документов человека (docs/v2/38-people-extensions.md §3.5, §10 CRUD
 * `/person-document-types`). Правит HR — `person.document.manage` на весь тенант (§2);
 * руководителю точки с тем же скоупом на точку сервер ответит `403`, экран покажет текст.
 *
 * Системный тип (семь штук §3.5) не удаляется, но правится и выключается. Выключенный
 * используемый тип уходит из формы добавления, документы по нему остаются (§12) — поэтому
 * удалить можно только неиспользуемый несистемный, остальное — «Вимкнути».
 */
definePageMeta({ layout: 'admin', middleware: 'admin-scope', requiredScope: 'person.document.manage' })

interface DocType {
  id: string
  code: string
  name: string
  isSystem: boolean
  isRequired: boolean
  requiredPositions: string[]
  validityMonths: number | null
  remindDays: number[]
  isFactOnly: boolean
  selfUpload: boolean
  visibleToManager: boolean
  isActive: boolean
  documentsCount: number
}
interface Ref { id: string, name: string }

const { t, te } = useI18n()
const { api, apiRaw } = useApi()

const rows = ref<DocType[]>([])
/** Правит справочник только HR (скоуп на весь тенант); руководитель точки видит его на чтение. */
const canManage = ref(false)
const positions = ref<Ref[]>([])
const error = ref('')
const busy = ref(false)
const editingId = ref<string | 'new' | null>(null)
const form = reactive({ name: '', isRequired: false, requiredPositions: [] as string[], validityMonths: '' as string | number, remindDays: '30, 7, 0', isFactOnly: false, selfUpload: false, visibleToManager: true })
const formError = ref('')

const errText = (err: unknown) => {
  const e = apiErrorOf(err)
  const key = `personDocTypes.err.${e.code === 'code.exists' ? 'code_exists' : e.code}`
  return te(key) ? t(key, { count: (e.details?.count as number | undefined) ?? 0 }) : e.message
}

async function load() {
  error.value = ''
  try {
    const [types, pos] = await Promise.all([apiRaw<{ data: DocType[], meta: { canManage: boolean } }>('/person-document-types'), api<Ref[]>('/refs/positions').catch(() => [])])
    rows.value = types.data
    canManage.value = types.meta.canManage
    positions.value = pos
  }
  catch (err) { error.value = errText(err) }
}
onMounted(load)

function edit(row: DocType | null) {
  formError.value = ''
  editingId.value = row?.id ?? 'new'
  Object.assign(form, row
    ? { name: row.name, isRequired: row.isRequired, requiredPositions: [...row.requiredPositions], validityMonths: row.validityMonths ?? '', remindDays: row.remindDays.join(', '), isFactOnly: row.isFactOnly, selfUpload: row.selfUpload, visibleToManager: row.visibleToManager }
    : { name: '', isRequired: false, requiredPositions: [], validityMonths: '', remindDays: '30, 7, 0', isFactOnly: false, selfUpload: false, visibleToManager: true })
}

/** «30, 7, 0» → [30, 7, 0]; всё, что не целое 0–365, — ошибка формы, а не молчаливый отброс. */
function parseRemind(s: string): number[] | null {
  const parts = s.split(',').map(x => x.trim()).filter(Boolean)
  if (!parts.length || parts.some(p => !/^\d{1,3}$/.test(p) || Number(p) > 365)) return null
  return parts.map(Number)
}

async function save() {
  const remindDays = parseRemind(form.remindDays)
  if (!remindDays) {
    formError.value = t('personDocTypes.err.remind')
    return
  }
  const body = {
    name: form.name.trim(),
    isRequired: form.isRequired,
    requiredPositions: form.requiredPositions,
    validityMonths: form.validityMonths === '' ? null : Number(form.validityMonths),
    remindDays,
    isFactOnly: form.isFactOnly,
    selfUpload: form.selfUpload,
    visibleToManager: form.visibleToManager,
  }
  busy.value = true
  formError.value = ''
  try {
    if (editingId.value === 'new') await api('/person-document-types', { method: 'POST', body })
    else await api(`/person-document-types/${editingId.value}`, { method: 'PATCH', body })
    editingId.value = null
    await load()
  }
  catch (err) { formError.value = errText(err) }
  finally { busy.value = false }
}

async function run(fn: () => Promise<unknown>) {
  busy.value = true
  error.value = ''
  try {
    await fn()
    await load()
  }
  catch (err) { error.value = errText(err) }
  finally { busy.value = false }
}
const toggleActive = (row: DocType) => run(() => api(`/person-document-types/${row.id}`, { method: 'PATCH', body: { isActive: !row.isActive } }))
const remove = (row: DocType) => { if (confirm(t('personDocTypes.deleteConfirm', { name: row.name }))) run(() => api(`/person-document-types/${row.id}`, { method: 'DELETE' })) }
const flags = (row: DocType) => [
  row.isSystem && t('personDocTypes.system'),
  row.isFactOnly && t('personDocTypes.factOnly'),
  row.selfUpload && t('personDocTypes.selfUpload'),
  !row.visibleToManager && t('personDocTypes.hiddenFromManager'),
  row.isActive ? t('personDocTypes.active') : t('personDocTypes.inactive'),
].filter(Boolean).join(' · ')
const positionNames = (ids: string[]) => ids.length ? ids.map(id => positions.value.find(p => p.id === id)?.name ?? '—').join(', ') : t('personDocTypes.allPositions')
</script>

<template>
  <div class="page">
    <NuxtLink to="/admin/refs" class="back">← {{ t('admin.nav.refs') }}</NuxtLink>
    <h1>{{ t('personDocTypes.title') }}</h1>
    <p class="muted intro">{{ t('personDocTypes.intro') }}</p>
    <p v-if="error" class="error-text" role="alert">{{ error }}</p>

    <div v-if="canManage" class="row">
      <button type="button" class="btn primary" @click="edit(null)">{{ t('personDocTypes.add') }}</button>
    </div>

    <form v-if="editingId && canManage" class="card form" novalidate @submit.prevent="save">
      <label class="label">{{ t('personDocTypes.name') }}
        <input v-model="form.name" class="field" required minlength="2" maxlength="120">
      </label>
      <div class="grid">
        <label class="label">{{ t('personDocTypes.validity') }}
          <input v-model="form.validityMonths" type="number" min="1" max="600" class="field" :placeholder="t('personDocTypes.noValidity')">
        </label>
        <label class="label">{{ t('personDocTypes.remindDays') }}
          <input v-model="form.remindDays" class="field" inputmode="numeric">
          <span class="help">{{ t('personDocTypes.remindHint') }}</span>
        </label>
      </div>
      <label class="toggle"><input v-model="form.isRequired" type="checkbox"> {{ t('personDocTypes.required') }}</label>
      <label v-if="form.isRequired" class="label">{{ t('personDocTypes.positions') }}
        <select v-model="form.requiredPositions" class="field" multiple size="5">
          <option v-for="p in positions" :key="p.id" :value="p.id">{{ p.name }}</option>
        </select>
        <span class="help">{{ t('personDocTypes.allPositions') }}</span>
      </label>
      <label class="toggle"><input v-model="form.isFactOnly" type="checkbox"> {{ t('personDocTypes.factOnly') }}<span class="hint">{{ t('personDocTypes.factOnlyHint') }}</span></label>
      <label class="toggle"><input v-model="form.selfUpload" type="checkbox"> {{ t('personDocTypes.selfUpload') }}</label>
      <label class="toggle"><input v-model="form.visibleToManager" type="checkbox"> {{ t('personDocTypes.visibleToManager') }}</label>
      <p v-if="formError" class="error-text" role="alert">{{ formError }}</p>
      <div class="row">
        <button type="submit" class="btn primary" :disabled="busy || form.name.trim().length < 2">{{ t('personDocTypes.save') }}</button>
        <button type="button" class="btn ghost" @click="editingId = null">{{ t('personDocTypes.cancel') }}</button>
      </div>
    </form>

    <p v-if="!rows.length && !error" class="muted">{{ t('personDocTypes.empty') }}</p>
    <div v-else class="table-wrap">
      <table class="table">
        <thead>
          <tr>
            <th scope="col">{{ t('personDocTypes.name') }}</th>
            <th scope="col">{{ t('personDocTypes.required') }}</th>
            <th scope="col">{{ t('personDocTypes.validity') }}</th>
            <th scope="col">{{ t('personDocTypes.documents') }}</th>
            <th v-if="canManage" scope="col"><span class="sr-only">{{ t('personDocTypes.edit') }}</span></th>
          </tr>
        </thead>
        <tbody>
          <tr v-for="row in rows" :key="row.id" :class="{ off: !row.isActive }">
            <td>
              <b>{{ row.name }}</b>
              <span class="sub">{{ flags(row) }}</span>
            </td>
            <td>{{ row.isRequired ? positionNames(row.requiredPositions) : '—' }}</td>
            <td>{{ row.validityMonths ? t('personDocTypes.months', { n: row.validityMonths }) : t('personDocTypes.noValidity') }}</td>
            <td class="num">{{ row.documentsCount }}</td>
            <td v-if="canManage" class="actions">
              <button type="button" class="btn ghost small" @click="edit(row)">{{ t('personDocTypes.edit') }}</button>
              <button type="button" class="btn ghost small" :disabled="busy" @click="toggleActive(row)">{{ row.isActive ? t('personDocTypes.disable') : t('personDocTypes.enable') }}</button>
              <button v-if="!row.isSystem && row.documentsCount === 0" type="button" class="btn ghost small" :disabled="busy" @click="remove(row)">{{ t('personDocTypes.delete') }}</button>
            </td>
          </tr>
        </tbody>
      </table>
    </div>
  </div>
</template>

<style scoped>
.page { display: grid; gap: var(--space-3); min-width: 0; }
.back { color: var(--color-ink-muted); text-decoration: none; font-size: var(--font-size-body-s); }
h1 { margin: 0; font-weight: 900; }
.intro { margin: 0; max-width: 70ch; }
.row { display: flex; gap: var(--space-2); flex-wrap: wrap; align-items: center; }
.form { display: grid; gap: var(--space-3); max-width: 640px; }
.grid { display: grid; grid-template-columns: repeat(auto-fit, minmax(200px, 1fr)); gap: var(--space-3); }
.label { display: grid; gap: var(--space-1); }
.actions { white-space: nowrap; }
.actions .btn + .btn { margin-left: var(--space-1); }
.off td { opacity: 0.6; }
.sr-only { position: absolute; width: 1px; height: 1px; overflow: hidden; clip: rect(0 0 0 0); white-space: nowrap; }
</style>
