<script setup lang="ts">
definePageMeta({ layout: 'admin', middleware: 'admin-scope' })

const { t } = useI18n()
const { api } = useApi()
const { hasScope } = useAuth()

const kinds = ['cities', 'position-levels', 'positions', 'org-units', 'locations', 'tags'] as const
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
    </div>

    <p v-if="error" class="error">{{ error }}</p>

    <div v-if="hasScope('settings.tenant')" class="add-row">
      <input v-model="newName" :placeholder="t('refs.newName')" @keyup.enter="add">
      <button class="primary" :disabled="!newName.trim()" @click="add">+</button>
    </div>

    <ul class="list">
      <li v-for="row in rows" :key="String(row.id)">
        {{ row.name }}
        <span v-if="row.levelName" class="sub">· {{ row.levelName }}</span>
        <span v-if="row.address" class="sub">· {{ row.address }}</span>
      </li>
      <li v-if="!loading && rows.length === 0" class="sub">—</li>
    </ul>
  </div>
</template>

<style scoped>
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
}

.sub {
  color: var(--color-ink-faint);
  font-size: var(--font-size-body-s);
}

.error {
  color: var(--color-coral-ink);
}
</style>
