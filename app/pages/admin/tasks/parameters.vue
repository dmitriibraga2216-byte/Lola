<script setup lang="ts">
/**
 * Довідник «Додаткові параметри для завдань» (docs/15 §14.5, D-016): тенант заводить свої
 * поля — текстове · вибір зі списку · числове — і переиспользує їх у параметрах призначення
 * (`PUT /tasks/:id/params`, група «Інші»). Простий CRUD-справочник, без окремого мокапа.
 */
definePageMeta({ layout: 'admin', middleware: 'admin-scope', requiredScope: 'assignment.create' })
const { t } = useI18n()
const { api } = useApi()

type Kind = 'text' | 'select' | 'number'
interface Param { id: string, name: string, kind: Kind, options: string[], isRequired: boolean }

const items = ref<Param[]>([])
const editing = ref<Param | null>(null)
const creating = ref(false)
const form = reactive<{ name: string, kind: Kind, optionsText: string, isRequired: boolean }>({ name: '', kind: 'text', optionsText: '', isRequired: false })
const error = ref('')

async function load() { items.value = await api<Param[]>('/task-parameters') }
onMounted(load)

function startCreate() {
  creating.value = true; editing.value = null; error.value = ''
  Object.assign(form, { name: '', kind: 'text', optionsText: '', isRequired: false })
}
function edit(p: Param) {
  editing.value = p; creating.value = false; error.value = ''
  Object.assign(form, { name: p.name, kind: p.kind, optionsText: p.options.join(', '), isRequired: p.isRequired })
}
function cancel() { creating.value = false; editing.value = null }

const options = computed(() => form.optionsText.split(',').map(s => s.trim()).filter(Boolean))
const canSave = computed(() => form.name.trim().length > 0 && (form.kind !== 'select' || options.value.length > 0))

async function save() {
  error.value = ''
  const body = { name: form.name.trim(), kind: form.kind, options: form.kind === 'select' ? options.value : [], isRequired: form.isRequired }
  try {
    if (creating.value) await api('/task-parameters', { method: 'POST', body })
    else if (editing.value) await api(`/task-parameters/${editing.value.id}`, { method: 'PATCH', body })
    creating.value = false; editing.value = null
    await load()
  }
  catch (err) { error.value = apiErrorOf(err).message }
}
async function remove(p: Param) {
  if (!confirm(t('taskParams.confirmDelete', { name: p.name }))) return
  error.value = ''
  try { await api(`/task-parameters/${p.id}`, { method: 'DELETE' }); if (editing.value?.id === p.id) editing.value = null; await load() }
  catch (err) { error.value = apiErrorOf(err).message }
}
</script>

<template>
  <div>
    <PageHeader :title="t('taskParams.title')" :crumbs="[{ label: t('admin.section.learning') }, { label: t('taskParams.title') }]">
      <template #actions><button class="btn primary" type="button" @click="startCreate">{{ t('taskParams.add') }}</button></template>
    </PageHeader>
    <p class="help">{{ t('taskParams.hint') }}</p>
    <p v-if="error" class="error-text" role="alert">{{ error }}</p>

    <div class="layout">
      <div class="table-wrap card">
        <table class="table">
          <thead><tr><th>{{ t('taskParams.name') }}</th><th>{{ t('taskParams.kind') }}</th><th>{{ t('taskParams.required') }}</th><th /></tr></thead>
          <tbody>
            <tr v-for="p in items" :key="p.id" :class="{ on: editing?.id === p.id }">
              <td><b>{{ p.name }}</b><div v-if="p.kind === 'select'" class="sub">{{ p.options.join(', ') }}</div></td>
              <td>{{ t(`taskParams.kindOption.${p.kind}`) }}</td>
              <td>{{ p.isRequired ? t('common.yes') : t('common.no') }}</td>
              <td class="actions-cell">
                <button class="btn ghost small" type="button" @click="edit(p)">{{ t('common.edit') }}</button>
                <button class="btn ghost small" type="button" @click="remove(p)">{{ t('common.delete') }}</button>
              </td>
            </tr>
            <tr v-if="!items.length"><td colspan="4" class="muted">{{ t('taskParams.empty') }}</td></tr>
          </tbody>
        </table>
      </div>

      <aside v-if="creating || editing" class="card editor">
        <h2 class="panel-title">{{ creating ? t('taskParams.new') : form.name }}</h2>
        <label class="label" for="tp-name">{{ t('taskParams.name') }}</label>
        <input id="tp-name" v-model="form.name" class="field" maxlength="120">
        <p class="label top">{{ t('taskParams.kind') }}</p>
        <div class="segmented">
          <button v-for="k in (['text', 'select', 'number'] as Kind[])" :key="k" type="button" :class="{ on: form.kind === k }" @click="form.kind = k">{{ t(`taskParams.kindOption.${k}`) }}</button>
        </div>
        <template v-if="form.kind === 'select'">
          <label class="label top" for="tp-options">{{ t('taskParams.options') }}</label>
          <input id="tp-options" v-model="form.optionsText" class="field" :placeholder="t('taskParams.optionsHint')">
        </template>
        <label class="toggle top"><input v-model="form.isRequired" type="checkbox"><span>{{ t('taskParams.required') }}</span></label>
        <div class="actions">
          <span class="spacer" />
          <button class="btn ghost" type="button" @click="cancel">{{ t('common.cancel') }}</button>
          <button class="btn primary" type="button" :disabled="!canSave" @click="save">{{ t('common.save') }}</button>
        </div>
      </aside>
    </div>
  </div>
</template>

<style scoped>
.layout { display: grid; grid-template-columns: minmax(0, 1fr) minmax(320px, 420px); gap: var(--space-4); align-items: start; margin-top: var(--space-3); }
.editor { display: grid; gap: var(--space-2); }
.top { margin-top: var(--space-3); }
.sub { font-size: var(--font-size-body-s); color: var(--color-ink-muted); }
.actions-cell { display: flex; gap: var(--space-1); white-space: nowrap; }
.actions { display: flex; gap: var(--space-2); align-items: center; margin-top: var(--space-2); }
.spacer { flex: 1; }
tr.on td { background: var(--color-sun-soft); }
@media (max-width: 900px) { .layout { grid-template-columns: 1fr; } }
</style>
