<script setup lang="ts">
/**
 * Категории ресурсов по мокапу ContentCategories (docs/21 §14.1, docs/30): карточки с числом
 * ресурсов, порядок перетаскиванием (и кнопками — с клавиатуры), «Додати категорію», подсказка о порядке.
 */
definePageMeta({ layout: 'admin', middleware: 'admin-scope', requiredScope: 'course.edit' })

const { t } = useI18n()
const { api } = useApi()

interface Category { id: string, name: string, sortOrder: number, resourcesCount: number }

const items = ref<Category[]>([])
const newName = ref('')
const editing = ref<string | null>(null)
const editName = ref('')
const error = ref('')
const busy = ref(false)
const dragId = ref<string | null>(null)

async function load() {
  try {
    items.value = await api<Category[]>('/resource-categories')
  }
  catch (err) {
    error.value = apiErrorOf(err).message
  }
}
onMounted(load)

async function add() {
  const name = newName.value.trim()
  if (!name) return
  busy.value = true
  try {
    await api('/resource-categories', { method: 'POST', body: { name } })
    newName.value = ''
    await load()
  }
  catch (err) {
    error.value = apiErrorOf(err).message
  }
  finally {
    busy.value = false
  }
}

function startEdit(c: Category) {
  editing.value = c.id
  editName.value = c.name
}

async function saveEdit(c: Category) {
  const name = editName.value.trim()
  editing.value = null
  if (!name || name === c.name) return
  try {
    await api(`/resource-categories/${c.id}`, { method: 'PATCH', body: { name } })
    await load()
  }
  catch (err) {
    error.value = apiErrorOf(err).message
  }
}

async function remove(c: Category) {
  if (!confirm(t('resource.deleteCategoryConfirm', { name: c.name }))) return
  try {
    await api(`/resource-categories/${c.id}`, { method: 'DELETE' })
    await load()
  }
  catch (err) {
    error.value = apiErrorOf(err).message
  }
}

async function persistOrder() {
  try {
    await api('/resource-categories/reorder', { method: 'POST', body: { ids: items.value.map(i => i.id) } })
  }
  catch (err) {
    error.value = apiErrorOf(err).message
    await load()
  }
}

function move(index: number, delta: number) {
  const target = index + delta
  if (target < 0 || target >= items.value.length) return
  const next = [...items.value]
  const [row] = next.splice(index, 1)
  next.splice(target, 0, row!)
  items.value = next
  persistOrder()
}

function onDrop(targetId: string) {
  if (!dragId.value || dragId.value === targetId) return
  const from = items.value.findIndex(i => i.id === dragId.value)
  const to = items.value.findIndex(i => i.id === targetId)
  if (from < 0 || to < 0) return
  const next = [...items.value]
  const [row] = next.splice(from, 1)
  next.splice(to, 0, row!)
  items.value = next
  dragId.value = null
  persistOrder()
}
</script>

<template>
  <div>
    <PageHeader :title="t('resource.categoriesTitle')" :crumbs="[{ label: t('admin.section.content') }, { label: t('resource.title'), to: '/admin/resources' }]" />

    <p v-if="error" class="note coral" role="alert">{{ error }}</p>

    <div class="split">
      <ul class="cards" role="list">
        <li
          v-for="(c, i) in items"
          :key="c.id"
          class="card cat"
          draggable="true"
          :class="{ dragging: dragId === c.id }"
          @dragstart="dragId = c.id"
          @dragover.prevent
          @drop.prevent="onDrop(c.id)"
          @dragend="dragId = null"
        >
          <span class="handle" aria-hidden="true">⋮⋮</span>
          <div class="body">
            <template v-if="editing === c.id">
              <input v-model="editName" class="field" :aria-label="t('resource.categoryName')" @keyup.enter="saveEdit(c)" @keyup.esc="editing = null" @blur="saveEdit(c)">
            </template>
            <template v-else>
              <button class="name" @click="startEdit(c)">{{ c.name }}</button>
              <span class="sub">{{ t('resource.categoriesCount', { n: c.resourcesCount }) }}</span>
            </template>
          </div>
          <div class="actions">
            <button class="chip" :aria-label="t('resource.moveUp')" :disabled="i === 0" @click="move(i, -1)">↑</button>
            <button class="chip" :aria-label="t('resource.moveDown')" :disabled="i === items.length - 1" @click="move(i, 1)">↓</button>
            <button class="chip coral" :aria-label="t('resource.delete')" @click="remove(c)">✕</button>
          </div>
        </li>
        <li class="card add">
          <input v-model="newName" class="field" :placeholder="t('resource.categoryName')" :aria-label="t('resource.categoryName')" @keyup.enter="add">
          <button class="btn primary" :disabled="busy || !newName.trim()" @click="add">{{ t('resource.addCategory') }}</button>
        </li>
      </ul>

      <aside class="card">
        <h2 class="panel-title">{{ t('resource.order') }}</h2>
        <p class="note sun">{{ t('resource.orderHint') }}</p>
      </aside>
    </div>
  </div>
</template>

<style scoped>
.split { display: grid; grid-template-columns: minmax(0, 1fr) 300px; gap: var(--space-4); align-items: start; }
.cards { list-style: none; margin: 0; padding: 0; display: grid; gap: var(--space-2); }
.cat { display: flex; align-items: center; gap: var(--space-3); cursor: grab; }
.cat.dragging { opacity: 0.5; }
.handle { color: var(--color-ink-faint); font-weight: 900; letter-spacing: -2px; }
.body { flex: 1; min-width: 0; display: grid; }
.name { font: inherit; font-weight: 800; background: none; border: none; text-align: left; padding: 0; cursor: text; color: var(--color-ink); }
.sub { color: var(--color-ink-faint); font-size: var(--font-size-body-s); }
.actions { display: flex; gap: var(--space-1); }
.chip.coral { color: var(--color-coral-ink); }
.add { display: flex; gap: var(--space-2); flex-wrap: wrap; }
.add .field { flex: 1 1 200px; }
@media (max-width: 900px) { .split { grid-template-columns: minmax(0, 1fr); } }
</style>
