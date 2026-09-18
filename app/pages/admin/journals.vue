<script setup lang="ts">
definePageMeta({ layout: 'admin', middleware: 'admin-scope', requiredScope: 'audit.view' })

const { t } = useI18n()

const tab = ref<'audit' | 'security'>('audit')
const rows = ref<Record<string, unknown>[]>([])
const error = ref('')

async function load() {
  error.value = ''
  try {
    const path = tab.value === 'audit' ? '/api/v1/audit' : '/api/v1/security-log'
    const res = await $fetch<{ data: Record<string, unknown>[] }>(path)
    rows.value = res.data
  }
  catch (err) {
    error.value = apiErrorOf(err).message
  }
}

watch(tab, load)
onMounted(load)
</script>

<template>
  <div>
    <h1>{{ t('admin.nav.journals') }}</h1>

    <div class="tabs">
      <button :class="['tab', { on: tab === 'audit' }]" @click="tab = 'audit'">
        {{ t('journals.audit') }}
      </button>
      <button :class="['tab', { on: tab === 'security' }]" @click="tab = 'security'">
        {{ t('journals.security') }}
      </button>
    </div>

    <p v-if="error" class="error">{{ error }}</p>

    <table class="table">
      <thead>
        <tr>
          <th>{{ t('journals.when') }}</th>
          <th>{{ t('journals.event') }}</th>
          <th>{{ t('journals.details') }}</th>
        </tr>
      </thead>
      <tbody>
        <tr v-for="row in rows" :key="String(row.id)">
          <td class="sub">{{ new Date(String(row.createdAt)).toLocaleString('uk') }}</td>
          <td><b>{{ row.action || row.event }}</b></td>
          <td class="sub details">{{ JSON.stringify(row.after ?? row.meta ?? {}) }}</td>
        </tr>
        <tr v-if="rows.length === 0">
          <td colspan="3" class="sub">—</td>
        </tr>
      </tbody>
    </table>
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
  padding: var(--space-2) var(--space-3);
  border-bottom: 1px solid var(--color-bg-line);
}

td {
  padding: var(--space-2) var(--space-3);
  border-bottom: 1px solid var(--color-bg-line-soft);
  vertical-align: top;
}

.sub {
  color: var(--color-ink-faint);
  font-size: var(--font-size-body-s);
}

.details {
  word-break: break-all;
  max-width: 480px;
}

.error {
  color: var(--color-coral-ink);
}
</style>
