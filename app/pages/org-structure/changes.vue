<script setup lang="ts">
import { ORG_JOURNAL_ACTIONS } from '#shared/domain/orgLayout'
import type { OrgJournalAction } from '#shared/domain/orgLayout'

/**
 * «Журнал змін структури» — `/org-structure/changes` (docs/v2/32 §5.2, §9, `v2/44` Р-OS.7):
 * Дата · Автор · Дія · Вузол · Було · Стало · Зачеплено нащадків; фильтры — период, дія, гілка.
 * Руководителю — только строки узлов своей ветки (сервер отдаёт уже отфильтрованное).
 */
definePageMeta({ layout: 'admin', middleware: 'admin-scope', requiredAnyScope: ['audit.view', 'org.structure.edit'] })

interface Row {
  id: string, at: string, actorId: string | null, actor: string | null, action: OrgJournalAction
  nodeId: string | null, node: string | null, before: Record<string, unknown> | null, after: Record<string, unknown> | null, affected: number | null
}
interface FlatNode { id: string, title: string, depth: number, children: FlatNode[] }

const { t } = useI18n()
const { api } = useApi()
const { hasScope } = useAuth()
const { formatDateTime } = useFormat()
const route = useRoute()

const filters = reactive({ from: '', to: '', action: '' as OrgJournalAction | '', nodeId: typeof route.query.nodeId === 'string' ? route.query.nodeId : '' })
const nodes = ref<{ id: string, title: string, depth: number }[]>([])
const rows = ref<Row[]>([])
const cursor = ref<string | null>(null)
const loaded = ref(false)
const error = ref(false)
const busy = ref(false)

const query = (): Record<string, string> => Object.fromEntries(Object.entries(filters).filter(([, v]) => v)) as Record<string, string>

async function load(more = false) {
  busy.value = true
  error.value = false
  try {
    const page = await api<{ rows: Row[], cursor: string | null }>('/org-structure/changes', { query: { ...query(), ...(more && cursor.value ? { cursor: cursor.value } : {}) } })
    rows.value = more ? [...rows.value, ...page.rows] : page.rows
    cursor.value = page.cursor
    loaded.value = true
  }
  catch { error.value = true }
  finally { busy.value = false }
}

function flatten(list: FlatNode[], out: { id: string, title: string, depth: number }[] = []) {
  for (const n of list) { out.push({ id: n.id, title: n.title, depth: n.depth }); flatten(n.children, out) }
  return out
}

onMounted(async () => {
  const tree = await api<{ nodes: FlatNode[] }>('/org-structure/tree', { query: { mode: 'view' } }).catch(() => ({ nodes: [] }))
  nodes.value = flatten(tree.nodes)
  await load()
})

/** «Було» / «Стало» — изменённые поля одной строкой: `поле: значення`. */
function fields(v: Record<string, unknown> | null): string {
  if (!v) return '—'
  const parts = Object.entries(v).filter(([k]) => k !== 'affected').map(([k, x]) => `${k}: ${x === null ? '—' : typeof x === 'object' ? JSON.stringify(x) : String(x)}`)
  return parts.length ? parts.join(' · ') : '—'
}
const exportUrl = (format: 'xlsx' | 'csv') => `/api/v1/org-structure/changes?${new URLSearchParams({ ...query(), format, limit: '500' }).toString()}`
</script>

<template>
  <div>
    <PageHeader :title="t('orgReports.changes.title')" :subtitle="t('orgReports.changes.hint')" :crumbs="[{ label: t('orgStructure.title'), to: '/org-structure' }]" />

    <form class="filters" @submit.prevent="load()">
      <div class="date-label"><label for="oc-from">{{ t('orgReports.from') }}</label> <input id="oc-from" v-model="filters.from" class="field" type="date"></div>
      <div class="date-label"><label for="oc-to">{{ t('orgReports.to') }}</label> <input id="oc-to" v-model="filters.to" class="field" type="date"></div>
      <label>{{ t('orgReports.col.action') }}
        <select v-model="filters.action" class="field">
          <option value="">{{ t('orgStructure.allOption') }}</option>
          <option v-for="a in ORG_JOURNAL_ACTIONS" :key="a" :value="a">{{ t(`orgReports.action.${a.replace('.', '_')}`) }}</option>
        </select>
      </label>
      <label>{{ t('orgReports.changes.branch') }}
        <select v-model="filters.nodeId" class="field">
          <option value="">{{ t('orgStructure.allOption') }}</option>
          <option v-for="n in nodes" :key="n.id" :value="n.id">{{ '· '.repeat(Math.max(n.depth - 1, 0)) }}{{ n.title }}</option>
        </select>
      </label>
      <button class="btn primary" type="submit" :disabled="busy">{{ t('orgReports.apply') }}</button>
    </form>

    <div v-if="hasScope('report.export')" class="export">
      <a class="btn ghost" :href="exportUrl('xlsx')" download>{{ t('orgReports.exportXlsx') }}</a>
      <a class="btn ghost" :href="exportUrl('csv')" download>{{ t('orgReports.exportCsv') }}</a>
    </div>

    <div v-if="error" class="note coral" role="alert">
      {{ t('orgReports.loadError') }}
      <button type="button" class="btn ghost" @click="load()">{{ t('orgReports.retry') }}</button>
    </div>
    <p v-else-if="!loaded" class="muted" aria-busy="true">{{ t('orgReports.loading') }}</p>
    <p v-else-if="rows.length === 0" class="muted">{{ t('orgReports.changes.empty') }}</p>
    <div v-else class="table-wrap">
      <table class="table">
        <thead>
          <tr>
            <th>{{ t('orgReports.col.date') }}</th>
            <th>{{ t('orgReports.col.actor') }}</th>
            <th>{{ t('orgReports.col.action') }}</th>
            <th>{{ t('orgReports.col.node') }}</th>
            <th>{{ t('orgReports.col.before') }}</th>
            <th>{{ t('orgReports.col.after') }}</th>
            <th class="num">{{ t('orgReports.col.affected') }}</th>
          </tr>
        </thead>
        <tbody>
          <tr v-for="r in rows" :key="r.id">
            <td class="nowrap">{{ formatDateTime(r.at) }}</td>
            <td>{{ r.actor ?? t('orgReports.system') }}</td>
            <td>{{ t(`orgReports.action.${r.action.replace('.', '_')}`) }}</td>
            <td>{{ r.node ?? '—' }}</td>
            <td class="fields">{{ fields(r.before) }}</td>
            <td class="fields">{{ fields(r.after) }}</td>
            <td class="num">{{ r.affected ?? '—' }}</td>
          </tr>
        </tbody>
      </table>
    </div>
    <button v-if="cursor" type="button" class="btn more" :disabled="busy" @click="load(true)">{{ t('orgReports.more') }}</button>
  </div>
</template>

<style scoped>
.filters { display: flex; flex-wrap: wrap; gap: var(--space-2); align-items: end; margin-bottom: var(--space-3); }
.filters label, .filters .date-label { display: grid; gap: var(--space-1); font-size: var(--font-size-body-s); font-weight: 700; min-width: 0; }
.filters .field { width: auto; min-width: 160px; padding: var(--space-2) var(--space-3); }
.export { display: flex; flex-wrap: wrap; gap: var(--space-2); margin-bottom: var(--space-3); }
.nowrap { white-space: nowrap; }
.fields { overflow-wrap: anywhere; font-size: var(--font-size-body-s); }
.more { margin-top: var(--space-3); }
@media (max-width: 480px) {
  .filters { flex-direction: column; align-items: stretch; }
  .filters .field { width: 100%; min-width: 0; }
}
</style>
