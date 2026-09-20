<script setup lang="ts">
definePageMeta({ layout: 'admin', middleware: 'admin-scope', requiredScope: 'people.view' })

/**
 * «Керування мітками» (мокап Tags, docs/16 §14.2): Мітка · Область дії · Опис · Використань.
 * Область дії обязательна — без неё на форме курса появляются метки должностей.
 */
const { t } = useI18n()
const { api } = useApi()
const { hasScope } = useAuth()

type Scope = 'user' | 'course' | 'resource' | 'question' | 'task'
interface Tag { id: string, name: string, scope: Scope, description: string | null, color: string | null, usage: number }
const SCOPES: Scope[] = ['user', 'course', 'resource', 'question', 'task']

const rows = ref<Tag[]>([])
const scope = ref<Scope | ''>('')
const error = ref('')
const notice = ref('')
const adding = ref(false)
const form = reactive({ name: '', scope: 'user' as Scope, description: '' })
const editId = ref<string | null>(null)
const edit = reactive({ name: '', description: '' })

async function load() {
  error.value = ''
  try { rows.value = await api<Tag[]>('/tags', { query: scope.value ? { scope: scope.value } : {} }) }
  catch (err) { error.value = apiErrorOf(err).message }
}
watch(scope, load)
onMounted(load)

async function run(fn: () => Promise<unknown>, done = '') {
  error.value = ''
  notice.value = ''
  try { await fn(); notice.value = done; await load() }
  catch (err) { error.value = apiErrorOf(err).message }
}
const create = () => run(async () => {
  await api('/tags', { method: 'POST', body: { name: form.name.trim(), scope: form.scope, description: form.description.trim() || null } })
  Object.assign(form, { name: '', description: '' })
  adding.value = false
}, t('common.saved'))
const save = (id: string) => run(async () => {
  await api(`/tags/${id}`, { method: 'PATCH', body: { name: edit.name.trim(), description: edit.description.trim() || null } })
  editId.value = null
}, t('common.saved'))
const remove = (row: Tag) => { if (confirm(t('tags.deleteConfirm', { name: row.name }))) run(() => api(`/tags/${row.id}`, { method: 'DELETE' })) }
function startEdit(row: Tag) { editId.value = row.id; Object.assign(edit, { name: row.name, description: row.description ?? '' }) }
const valid = computed(() => form.name.trim().length > 0 && form.name.trim().length <= 40 && !/[<>]/.test(form.name))
</script>

<template>
  <div>
    <PageHeader :title="t('tags.title')" :crumbs="[{ label: t('admin.nav.people'), to: '/admin/people' }]" :subtitle="t('tags.hint')">
      <template #actions>
        <button v-if="hasScope('settings.tenant')" class="btn primary" :aria-expanded="adding" @click="adding = !adding">{{ t('tags.add') }}</button>
      </template>
    </PageHeader>

    <form v-if="adding" class="add card" @submit.prevent="create">
      <label>{{ t('tags.col.name') }}<input v-model="form.name" maxlength="40" required :placeholder="t('tags.namePlaceholder')"></label>
      <label>{{ t('tags.col.scope') }}<select v-model="form.scope" required><option v-for="s in SCOPES" :key="s" :value="s">{{ t(`tags.scope.${s}`) }}</option></select></label>
      <label class="grow">{{ t('tags.col.description') }}<input v-model="form.description" maxlength="200"></label>
      <button type="submit" class="btn primary" :disabled="!valid">{{ t('common.save') }}</button>
      <button type="button" class="btn" @click="adding = false">{{ t('common.cancel') }}</button>
      <p v-if="form.name && !valid" class="error">{{ t('tags.nameRule') }}</p>
    </form>

    <div class="chips" role="tablist">
      <button role="tab" :aria-selected="scope === ''" :class="['chip', { on: scope === '' }]" @click="scope = ''">{{ t('tags.allScopes') }}</button>
      <button v-for="s in SCOPES" :key="s" role="tab" :aria-selected="scope === s" :class="['chip', { on: scope === s }]" @click="scope = s">{{ t(`tags.scope.${s}`) }}</button>
    </div>

    <p v-if="error" class="error" role="alert">{{ error }}</p>
    <p v-if="notice" class="notice" role="status">{{ notice }}</p>

    <div class="table-wrap">
      <table class="table">
        <thead><tr><th>{{ t('tags.col.name') }}</th><th>{{ t('tags.col.scope') }}</th><th>{{ t('tags.col.description') }}</th><th class="num">{{ t('tags.col.usage') }}</th><th v-if="hasScope('settings.tenant')" /></tr></thead>
        <tbody>
          <tr v-for="row in rows" :key="row.id">
            <template v-if="editId === row.id">
              <td><input v-model="edit.name" maxlength="40" :aria-label="t('tags.col.name')" @keyup.enter="save(row.id)" @keyup.esc="editId = null"></td>
              <td><span class="pill">{{ t(`tags.scope.${row.scope}`) }}</span></td>
              <td><input v-model="edit.description" maxlength="200" :aria-label="t('tags.col.description')" @keyup.enter="save(row.id)"></td>
              <td class="num">{{ row.usage }}</td>
              <td class="actions"><button class="btn small primary" @click="save(row.id)">{{ t('common.save') }}</button><button class="btn small" @click="editId = null">{{ t('common.cancel') }}</button></td>
            </template>
            <template v-else>
              <td><span class="tag">{{ row.name }}</span></td>
              <td><span class="pill">{{ t(`tags.scope.${row.scope}`) }}</span></td>
              <td class="desc">{{ row.description || '—' }}</td>
              <td class="num">{{ row.usage }}</td>
              <td v-if="hasScope('settings.tenant')" class="actions">
                <button class="btn small" @click="startEdit(row)">{{ t('common.edit') }}</button>
                <button class="btn small danger" :disabled="row.usage > 0" :title="row.usage > 0 ? t('tags.inUse', { n: row.usage }) : ''" @click="remove(row)">{{ t('common.delete') }}</button>
              </td>
            </template>
          </tr>
          <tr v-if="rows.length === 0"><td colspan="5" class="sub">{{ t('tags.empty') }}</td></tr>
        </tbody>
      </table>
    </div>
  </div>
</template>

<style scoped>
.card { background: var(--color-bg-soft); border-radius: var(--radius-m); padding: var(--space-3) var(--space-4); }
.add { display: flex; gap: var(--space-3); align-items: end; flex-wrap: wrap; margin-bottom: var(--space-3); }
.add label { display: grid; gap: var(--space-1); font-size: var(--font-size-body-s); color: var(--color-ink-muted); font-weight: 700; }
.add .grow { flex: 1 1 200px; }
.chips { display: flex; gap: var(--space-2); flex-wrap: wrap; margin-bottom: var(--space-3); }
.chip { font: inherit; font-size: var(--font-size-body-s); font-weight: 700; border: 1px solid var(--color-bg-line); background: transparent; color: var(--color-ink-muted); border-radius: var(--radius-pill); padding: var(--space-1) var(--space-3); cursor: pointer; }
.chip.on { background: var(--color-ink); border-color: var(--color-ink); color: var(--color-bg-soft); }
input, select { font: inherit; border: 1px solid var(--color-bg-line); border-radius: var(--radius-s); padding: var(--space-1) var(--space-2); background: var(--color-bg); color: var(--color-ink); max-width: 100%; box-sizing: border-box; }
.btn { font: inherit; font-weight: 700; border: 1px solid var(--color-bg-line); background: var(--color-bg-soft); color: var(--color-ink); border-radius: var(--radius-pill); padding: var(--space-1) var(--space-4); cursor: pointer; }
.btn.primary { background: var(--color-sun); border-color: var(--color-sun); }
.btn.danger { background: var(--color-coral); border-color: var(--color-coral); color: var(--color-coral-deep); }
.btn.small { font-size: var(--font-size-body-s); padding: 0 var(--space-3); }
.btn:disabled { opacity: 0.5; cursor: default; }
.table-wrap { overflow-x: auto; }
.table { width: 100%; border-collapse: collapse; background: var(--color-bg-soft); border-radius: var(--radius-m); overflow: hidden; }
th { text-align: left; font-size: var(--font-size-body-s); color: var(--color-ink-muted); padding: var(--space-2) var(--space-3); border-bottom: 1px solid var(--color-bg-line); text-transform: uppercase; letter-spacing: 0.04em; white-space: nowrap; }
td { padding: var(--space-2) var(--space-3); border-bottom: 1px solid var(--color-bg-line-soft); vertical-align: middle; }
.num { text-align: right; font-variant-numeric: tabular-nums; }
.desc { color: var(--color-ink-muted); }
.tag { display: inline-block; background: var(--color-sun); border-radius: var(--radius-pill); padding: 2px var(--space-3); font-weight: 800; }
.pill { display: inline-block; font-family: ui-monospace, monospace; font-size: var(--font-size-body-s); background: var(--color-bg-line-soft); border-radius: var(--radius-pill); padding: 2px var(--space-3); }
.actions { display: flex; gap: var(--space-2); flex-wrap: wrap; }
.sub { color: var(--color-ink-muted); font-size: var(--font-size-body-s); }
.error { color: var(--color-coral-ink); }
.notice { color: var(--color-teal-ink); }
</style>
