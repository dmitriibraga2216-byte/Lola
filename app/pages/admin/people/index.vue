<script setup lang="ts">
definePageMeta({ layout: 'admin', middleware: 'admin-scope' })

const { t } = useI18n()


interface PersonRow {
  id: string
  fullName: string
  phone: string | null
  status: string
  tags: string[]
  cityName: string | null
  lastSeenAt: string | null
  placements: { isPrimary: boolean, locationName: string, positionName: string }[]
  roles: string[]
}

const tab = ref<'active' | 'blocked' | 'all'>('active')
const q = ref('')
const items = ref<PersonRow[]>([])
const cursor = ref<string | null>(null)
const loading = ref(false)
const error = ref('')

async function load(reset = true) {
  loading.value = true
  error.value = ''
  try {
    const res = await $fetch<{ data: PersonRow[], meta: { cursor: string | null } }>('/api/v1/people', {
      query: {
        tab: tab.value,
        ...(q.value ? { q: q.value } : {}),
        ...(!reset && cursor.value ? { cursor: cursor.value } : {}),
      },
    })
    items.value = reset ? res.data : [...items.value, ...res.data]
    cursor.value = res.meta.cursor
  }
  catch (err) {
    error.value = apiErrorOf(err).message
  }
  finally {
    loading.value = false
  }
}

watch(tab, () => load())
let searchTimer: ReturnType<typeof setTimeout>
watch(q, () => {
  clearTimeout(searchTimer)
  searchTimer = setTimeout(() => load(), 300)
})
onMounted(() => load())

function statusLabel(s: string) {
  return t(`people.status.${s}`)
}
</script>

<template>
  <div>
    <header class="head">
      <h1>{{ t('admin.nav.people') }}</h1>
      <input v-model="q" class="search" type="search" :placeholder="t('people.search')">
    </header>

    <div class="tabs">
      <button
        v-for="option in (['active', 'blocked', 'all'] as const)"
        :key="option"
        :class="['tab', { on: tab === option }]"
        @click="tab = option"
      >
        {{ t(`people.tab.${option}`) }}
      </button>
    </div>

    <p v-if="error" class="error">{{ error }}</p>

    <div v-if="loading && items.length === 0" class="empty">{{ t('common.loading') }}</div>
    <div v-else-if="items.length === 0" class="empty">{{ t('people.empty') }}</div>

    <table v-else class="table">
      <thead>
        <tr>
          <th>{{ t('people.col.name') }}</th>
          <th>{{ t('people.col.position') }}</th>
          <th>{{ t('people.col.location') }}</th>
          <th>{{ t('people.col.roles') }}</th>
          <th>{{ t('people.col.status') }}</th>
          <th>{{ t('people.col.lastSeen') }}</th>
        </tr>
      </thead>
      <tbody>
        <tr v-for="person in items" :key="person.id" class="row" @click="navigateTo(`/admin/people/${person.id}`)">
          <td>
            <div class="name">{{ person.fullName }}</div>
            <div class="sub">{{ person.phone }}</div>
          </td>
          <td>{{ person.placements.find(p => p.isPrimary)?.positionName || '—' }}</td>
          <td>{{ person.placements.find(p => p.isPrimary)?.locationName || '—' }}</td>
          <td>{{ person.roles.join(', ') || '—' }}</td>
          <td>
            <span :class="['badge', person.status]">{{ statusLabel(person.status) }}</span>
          </td>
          <td class="sub">{{ person.lastSeenAt ? new Date(person.lastSeenAt).toLocaleDateString('uk') : '—' }}</td>
        </tr>
      </tbody>
    </table>

    <button v-if="cursor" class="more" :disabled="loading" @click="load(false)">
      {{ t('common.loadMore') }}
    </button>
  </div>
</template>

<style scoped>
.head {
  display: flex;
  align-items: center;
  gap: var(--space-4);
  margin-bottom: var(--space-4);
  flex-wrap: wrap;
}

h1 {
  margin: 0;
  font-weight: 900;
}

.search {
  margin-left: auto;
  font: inherit;
  border: 1px solid var(--color-bg-line);
  border-radius: var(--radius-pill);
  padding: var(--space-2) var(--space-4);
  background: var(--color-bg-soft);
  color: var(--color-ink);
  min-width: 220px;
}

.tabs {
  display: flex;
  gap: var(--space-2);
  margin-bottom: var(--space-4);
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

.table {
  width: 100%;
  border-collapse: collapse;
  background: var(--color-bg-soft);
  border-radius: var(--radius-m);
  overflow: hidden;
}

th {
  text-align: left;
  font-size: var(--font-size-body-s);
  color: var(--color-ink-muted);
  padding: var(--space-3) var(--space-4);
  border-bottom: 1px solid var(--color-bg-line);
}

td {
  padding: var(--space-3) var(--space-4);
  border-bottom: 1px solid var(--color-bg-line-soft);
  vertical-align: top;
}

.row {
  cursor: pointer;
}

.row:hover {
  background: var(--color-bg);
}

.name {
  font-weight: 700;
}

.sub {
  font-size: var(--font-size-body-s);
  color: var(--color-ink-faint);
}

.badge {
  font-size: var(--font-size-body-s);
  font-weight: 700;
  border-radius: var(--radius-pill);
  padding: 2px var(--space-3);
  background: var(--color-bg-line-soft);
}

.badge.active {
  background: var(--color-teal);
  color: var(--color-teal-deep);
}

.badge.invited {
  background: var(--color-sun);
  color: var(--color-sun-ink);
}

.badge.suspended,
.badge.archived {
  background: var(--color-coral);
  color: var(--color-coral-deep);
}

.empty {
  padding: var(--space-7);
  text-align: center;
  color: var(--color-ink-faint);
}

.error {
  color: var(--color-coral-ink);
}

.more {
  margin-top: var(--space-4);
  font: inherit;
  font-weight: 700;
  border: 1px solid var(--color-bg-line);
  background: var(--color-bg-soft);
  border-radius: var(--radius-pill);
  padding: var(--space-2) var(--space-5);
  cursor: pointer;
  color: var(--color-ink);
}
</style>
