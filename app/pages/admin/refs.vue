<script setup lang="ts">
definePageMeta({ layout: 'admin', middleware: 'admin-scope' })

const { t } = useI18n()
const { api } = useApi()
const { hasScope } = useAuth()

const kinds = ['cities', 'positions', 'position-levels', 'org-units', 'locations'] as const
type Kind = typeof kinds[number]

const kind = ref<Kind>('cities')
const rows = ref<Record<string, unknown>[]>([])
const newName = ref('')
const error = ref('')
const loading = ref(false)

async function load() {
  loading.value = true
  error.value = ''
  try {
    rows.value = await api<Record<string, unknown>[]>(`/refs/${kind.value}`)
  }
  catch (err) {
    error.value = apiErrorOf(err).message
  }
  finally {
    loading.value = false
  }
}

watch(kind, load)
onMounted(load)

async function add() {
  if (!newName.value.trim()) return
  error.value = ''
  try {
    const body: Record<string, unknown> = { name: newName.value.trim() }
    if (kind.value === 'locations') {
      const units = await api<{ id: string }[]>('/refs/org-units')
      body.orgUnitId = units[0]?.id
    }
    await api(`/refs/${kind.value}`, { method: 'POST', body })
    newName.value = ''
    await load()
  }
  catch (err) {
    error.value = apiErrorOf(err).message
  }
}

// docs/16 §3.3: переименование, деактивация, удаление (если не используется), слияние
const editId = ref<string | null>(null)
const editName = ref('')
const mergeFrom = ref<Record<string, unknown> | null>(null)
const mergeInto = ref('')
async function run(fn: () => Promise<unknown>) {
  error.value = ''
  try { await fn(); editId.value = null; mergeFrom.value = null; await load() }
  catch (err) { error.value = apiErrorOf(err).message }
}
const rename = (id: string) => run(() => api(`/refs/${kind.value}/${id}`, { method: 'PATCH', body: { name: editName.value.trim() } }))
const toggleActive = (row: Record<string, unknown>) => run(() => api(`/refs/${kind.value}/${row.id}`, { method: 'PATCH', body: { isActive: !row.isActive } }))
const remove = (row: Record<string, unknown>) => { if (confirm(t('refs.deleteConfirm', { name: String(row.name) }))) run(() => api(`/refs/${kind.value}/${row.id}`, { method: 'DELETE' })) }
const merge = () => run(() => api(`/refs/${kind.value}/merge`, { method: 'POST', body: { fromId: mergeFrom.value!.id, intoId: mergeInto.value } }))
const hasActive = computed(() => ['cities', 'positions', 'locations'].includes(kind.value))
</script>

<template>
  <div>
    <h1>{{ t('admin.nav.refs') }}</h1>

    <div class="tabs">
      <button
        v-for="k in kinds"
        :key="k"
        :class="['tab', { on: kind === k }]"
        @click="kind = k"
      >
        {{ t(`refs.${k}`) }}
      </button>
      <NuxtLink to="/admin/tags" class="tab">{{ t('refs.tags') }} →</NuxtLink>
    </div>
    <p class="sub count">{{ t('refs.count', { n: rows.length }) }}</p>

    <p v-if="error" class="error">{{ error }}</p>

    <div v-if="hasScope('settings.tenant')" class="add-row">
      <input v-model="newName" :placeholder="t('refs.newName')" @keyup.enter="add">
      <button class="primary" :disabled="!newName.trim()" @click="add">+</button>
    </div>

    <div v-if="mergeFrom" class="add-row">
      <span>{{ t('refs.mergeInto', { from: String(mergeFrom.name) }) }}</span>
      <select v-model="mergeInto" :aria-label="t('refs.merge')"><option value="" disabled>—</option><option v-for="r in rows.filter(x => x.id !== mergeFrom!.id)" :key="String(r.id)" :value="String(r.id)">{{ r.name }}</option></select>
      <button class="primary" :disabled="!mergeInto" @click="merge">{{ t('refs.merge') }}</button>
      <button class="ghost" @click="mergeFrom = null">{{ t('common.cancel') }}</button>
    </div>

    <ul class="list">
      <li v-for="row in rows" :key="String(row.id)" :class="{ off: row.isActive === false }">
        <template v-if="editId === row.id">
          <input v-model="editName" :aria-label="t('refs.edit')" @keyup.enter="rename(String(row.id))" @keyup.esc="editId = null">
          <button class="primary small" @click="rename(String(row.id))">{{ t('common.save') }}</button>
          <button class="ghost small" @click="editId = null">{{ t('common.cancel') }}</button>
        </template>
        <template v-else>
          {{ row.name }}
          <span v-if="row.isActive === false" class="sub">· {{ t('refs.inactive') }}</span>
          <span v-if="row.levelName" class="sub">· {{ row.levelName }}</span>
          <span v-if="row.address" class="sub">· {{ row.address }}</span>
          <span v-if="row.peopleCount !== undefined" class="sub">· {{ t('refs.people', { n: row.peopleCount }) }}</span>
          <span v-if="hasScope('settings.tenant')" class="row-actions">
            <button class="ghost small" @click="editId = String(row.id); editName = String(row.name)">{{ t('refs.edit') }}</button>
            <button v-if="hasActive" class="ghost small" @click="toggleActive(row)">{{ row.isActive === false ? t('common.activate') : t('common.deactivate') }}</button>
            <button v-if="kind !== 'org-units'" class="ghost small" @click="mergeFrom = row; mergeInto = ''">{{ t('refs.merge') }}</button>
            <button class="ghost small danger" @click="remove(row)">×</button>
          </span>
        </template>
      </li>
      <li v-if="!loading && rows.length === 0" class="sub">—</li>
    </ul>
  </div>
</template>

<style scoped>
.count { margin: 0 0 var(--space-2); }
a.tab { text-decoration: none; }
h1 {
  margin: 0 0 var(--space-4);
  font-weight: 900;
}

.tabs {
  display: flex;
  gap: var(--space-2);
  margin-bottom: var(--space-4);
  flex-wrap: wrap;
}

.tab {
  font: inherit;
  font-weight: 700;
  border: 1px solid var(--color-bg-line);
  background: transparent;
  color: var(--color-ink-muted);
  border-radius: var(--radius-pill);
  padding: var(--space-1) var(--space-4);
  cursor: pointer;
}

.tab.on {
  background: var(--color-ink);
  border-color: var(--color-ink);
  color: var(--color-bg-soft);
}

.add-row {
  display: flex;
  gap: var(--space-2);
  margin-bottom: var(--space-4);
}

input {
  font: inherit;
  border: 1px solid var(--color-bg-line);
  border-radius: var(--radius-s);
  padding: var(--space-2) var(--space-3);
  background: var(--color-bg-soft);
  color: var(--color-ink);
}

.primary {
  font: inherit;
  font-weight: 800;
  border: none;
  background: var(--color-sun);
  color: var(--color-ink);
  border-radius: var(--radius-pill);
  padding: var(--space-1) var(--space-4);
  cursor: pointer;
}

.list {
  list-style: none;
  margin: 0;
  padding: 0;
  display: grid;
  gap: var(--space-1);
  max-width: 480px;
}

.list li {
  background: var(--color-bg-soft);
  border-radius: var(--radius-s);
  padding: var(--space-2) var(--space-4);
  display: flex;
  gap: var(--space-2);
  align-items: center;
  flex-wrap: wrap;
}

.sub {
  color: var(--color-ink-faint);
  font-size: var(--font-size-body-s);
}

.error {
  color: var(--color-coral-ink);
}
.off { opacity: 0.55; }
.row-actions { margin-left: auto; display: inline-flex; gap: var(--space-1); flex-wrap: wrap; }
.small { font-size: var(--font-size-body-s); padding: 0 var(--space-2); }
.ghost { font: inherit; border: 1px solid transparent; background: transparent; color: var(--color-ink-muted); border-radius: var(--radius-pill); cursor: pointer; }
.ghost:hover { border-color: var(--color-bg-line); }
.ghost.danger { color: var(--color-coral-ink); }
select { font: inherit; border: 1px solid var(--color-bg-line); border-radius: var(--radius-s); padding: var(--space-1) var(--space-2); background: var(--color-bg); color: var(--color-ink); }
</style>
