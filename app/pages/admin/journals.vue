<script setup lang="ts">
definePageMeta({ layout: 'admin', middleware: 'admin-scope', requiredScope: 'audit.view' })

const { t } = useI18n()
const { api, apiRaw } = useApi()
type Kind = 'status' | 'notifications' | 'sessions' | 'security' | 'import' | 'automation' | 'integrations'
const KINDS: Kind[] = ['status', 'notifications', 'sessions', 'security', 'import', 'automation', 'integrations']
const tab = ref<Kind>('security')
const rows = ref<Record<string, unknown>[]>([])
const retention = ref(0)
const error = ref('')
const filters = reactive({ from: '', to: '', userId: '', type: '' })
const people = ref<{ id: string, fullName: string }[]>([])
const search = ref('')
const opened = ref<string | null>(null)

async function load() {
  error.value = ''
  try {
    const r = await api<{ rows: Record<string, unknown>[], retentionDays: number }>(`/logs/${tab.value}`, { query: Object.fromEntries(Object.entries(filters).filter(([, v]) => v)) })
    rows.value = r.rows; retention.value = r.retentionDays
  }
  catch (err) { error.value = apiErrorOf(err).message }
}
watch(tab, load)
watch(filters, load)
onMounted(load)
let timer: ReturnType<typeof setTimeout>
watch(search, (v) => { clearTimeout(timer); if (!v.trim()) { people.value = []; return } timer = setTimeout(async () => { try { people.value = (await apiRaw<{ data: { id: string, fullName: string }[] }>('/people', { query: { q: v, tab: 'all', limit: 8 } })).data } catch { people.value = [] } }, 300) })
const columns = computed(() => rows.value[0] ? Object.keys(rows.value[0]).filter(k => !['id', 'user_id', 'meta', 'payload', 'response_body', 'actions_result', 'trigger_payload', 'rendered_text', 'stats', 'entity_id'].includes(k)) : [])
const fmt = (v: unknown) => v == null ? '—' : typeof v === 'string' && /^\d{4}-\d{2}-\d{2}T/.test(v) ? new Date(v).toLocaleString('uk', { dateStyle: 'short', timeStyle: 'short' }) : typeof v === 'object' ? JSON.stringify(v) : String(v)
const exportUrl = computed(() => `/api/v1/logs/${tab.value}?${new URLSearchParams({ ...Object.fromEntries(Object.entries(filters).filter(([, v]) => v)), limit: '500' })}`)
</script>

<template>
  <div>
    <h1>{{ t('admin.nav.journals') }}</h1>
    <div class="tabs" role="tablist">
      <button v-for="k in KINDS" :key="k" role="tab" :aria-selected="tab === k" :class="['tab', { on: tab === k }]" @click="tab = k">{{ t(`journals.kind.${k}`) }}</button>
    </div>
    <p class="sub">{{ t('journals.retention', { days: retention }) }} · {{ t('journals.immutable') }}</p>
    <div class="filters">
      <label>{{ t('reports.from') }} <input v-model="filters.from" type="date"></label>
      <label>{{ t('reports.to') }} <input v-model="filters.to" type="date"></label>
      <label>{{ t('journals.type') }} <input v-model="filters.type" :placeholder="t('journals.typeHint')"></label>
      <label>{{ t('people.col.name') }} <input v-model="search" :placeholder="t('orgAdmin.searchPerson')"></label>
      <div v-if="people.length" class="found"><button v-for="p in people" :key="p.id" class="chip" @click="filters.userId = p.id; search = p.fullName; people = []">{{ p.fullName }}</button></div>
      <button v-if="filters.userId" class="chip" @click="filters.userId = ''; search = ''">× {{ search }}</button>
      <a :href="exportUrl" class="chip" download>JSON</a>
    </div>
    <p v-if="error" class="error" role="alert">{{ error }}</p>
    <div class="table-wrap">
      <table v-if="rows.length" class="table">
        <thead><tr><th v-for="c in columns" :key="c">{{ t(`journals.col.${c}`, c) }}</th><th /></tr></thead>
        <tbody>
          <template v-for="r in rows" :key="String(r.id)">
            <tr><td v-for="c in columns" :key="c" :class="{ mono: c === 'action' || c === 'event' || c === 'code' }">{{ fmt(r[c]) }}</td><td><button class="chip" @click="opened = opened === String(r.id) ? null : String(r.id)">…</button></td></tr>
            <tr v-if="opened === String(r.id)"><td :colspan="columns.length + 1"><pre class="pre">{{ JSON.stringify(r, null, 2) }}</pre></td></tr>
          </template>
        </tbody>
      </table>
      <p v-else class="sub">{{ t('reports.noData') }}</p>
    </div>
  </div>
</template>

<style scoped>
h1 { margin: 0 0 var(--space-3); font-weight: 900; }
.tabs { display: flex; gap: var(--space-2); margin-bottom: var(--space-2); flex-wrap: wrap; }
.tab { font: inherit; font-weight: 700; border: 1px solid var(--color-bg-line); background: transparent; color: var(--color-ink-muted); border-radius: var(--radius-pill); padding: var(--space-1) var(--space-4); cursor: pointer; }
.tab.on { background: var(--color-ink); border-color: var(--color-ink); color: var(--color-bg-soft); }
.filters { display: flex; gap: var(--space-3); align-items: end; flex-wrap: wrap; margin: var(--space-2) 0 var(--space-3); }
.filters label { display: grid; gap: var(--space-1); font-size: var(--font-size-body-s); color: var(--color-ink-muted); }
input { font: inherit; border: 1px solid var(--color-bg-line); border-radius: var(--radius-s); padding: var(--space-1) var(--space-2); background: var(--color-bg); color: var(--color-ink); }
.found { display: flex; gap: var(--space-1); flex-wrap: wrap; }
.chip { font: inherit; font-size: var(--font-size-body-s); font-weight: 700; border: 1px solid var(--color-bg-line); background: transparent; color: var(--color-ink-muted); border-radius: var(--radius-pill); padding: var(--space-1) var(--space-3); cursor: pointer; text-decoration: none; }
.table-wrap { overflow-x: auto; }
.table { width: 100%; border-collapse: collapse; background: var(--color-bg-soft); border-radius: var(--radius-m); overflow: hidden; }
th { text-align: left; font-size: var(--font-size-body-s); color: var(--color-ink-muted); padding: var(--space-2) var(--space-3); border-bottom: 1px solid var(--color-bg-line); white-space: nowrap; }
td { padding: var(--space-2) var(--space-3); border-bottom: 1px solid var(--color-bg-line-soft); vertical-align: top; font-size: var(--font-size-body-s); max-width: 320px; overflow: hidden; text-overflow: ellipsis; }
.mono { font-family: ui-monospace, monospace; }
.pre { margin: 0; white-space: pre-wrap; font-size: 12px; max-height: 300px; overflow: auto; }
.sub { font-size: var(--font-size-body-s); color: var(--color-ink-faint); }
.error { color: var(--color-coral-ink); }
</style>
