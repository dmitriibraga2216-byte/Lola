<script setup lang="ts">
definePageMeta({ layout: 'admin', middleware: 'admin-scope', requiredScope: 'request.decide' })
const { t } = useI18n()
const { api } = useApi()
interface Ext { id: string, title: string, provider: string | null, format: string, cost: string | null, currency: string, justification: string | null, status: string, fullName: string }
interface Car { id: string, targetPosition: string, motivation: string | null, status: string, fullName: string }
const data = ref<{ external: Ext[], career: Car[] }>({ external: [], career: [] })
const error = ref('')
const comment = ref<Record<string, string>>({})
async function load() { try { data.value = await api('/development/requests/pending') } catch (err) { error.value = apiErrorOf(err).message } }
onMounted(load)
async function decide(kind: 'external' | 'career', id: string, decision: 'approve' | 'reject') {
  error.value = ''
  try { await api(`/development/requests/${kind}/${id}/decide`, { method: 'POST', body: { decision, comment: comment.value[id] || undefined } }); await load() }
  catch (err) { error.value = apiErrorOf(err).message }
}

// docs/33 D-033, мокап ExternalRequests: повна таблиця всіх заявок (не тільки «на розгляд») з фільтрами
interface TExt { id: string, title: string, cost: string | null, currency: string, status: string, fullName: string, createdAt: string, responsible: string | null, kind: 'external' }
interface TCar { id: string, targetPosition: string, status: string, fullName: string, createdAt: string, responsible: string | null, kind: 'career' }
const view = ref<'queue' | 'table'>('queue')
const table = ref<{ external: TExt[], career: TCar[] } | null>(null)
const tableError = ref('')
const filters = reactive({ kind: '' as '' | 'external' | 'career', status: '', from: '', to: '' })
async function loadTable() {
  tableError.value = ''
  try {
    table.value = await api('/development/requests', {
      query: { ...(filters.kind ? { kind: filters.kind } : {}), ...(filters.status ? { status: filters.status } : {}), ...(filters.from ? { from: filters.from } : {}), ...(filters.to ? { to: filters.to } : {}) },
    })
  }
  catch (err) { tableError.value = apiErrorOf(err).message }
}
watch(view, v => { if (v === 'table' && !table.value) loadTable() })
watch(filters, () => { if (view.value === 'table') loadTable() }, { deep: true })
const STATUSES = ['new', 'manager_approved', 'hr_approved', 'approved', 'rejected', 'completed'] as const
interface Row { id: string, kind: 'external' | 'career', title: string, fullName: string, cost: string | null, currency: string, responsible: string | null, status: string, createdAt: string }
const rows = computed<Row[]>(() => {
  if (!table.value) return []
  const ext = table.value.external.map(r => ({ id: r.id, kind: 'external' as const, title: r.title, fullName: r.fullName, cost: r.cost, currency: r.currency, responsible: r.responsible, status: r.status, createdAt: r.createdAt }))
  const car = table.value.career.map(r => ({ id: r.id, kind: 'career' as const, title: r.targetPosition, fullName: r.fullName, cost: null, currency: '', responsible: r.responsible, status: r.status, createdAt: r.createdAt }))
  return [...ext, ...car].sort((a, b) => +new Date(b.createdAt) - +new Date(a.createdAt))
})
const fmt = (d: string) => new Date(d).toLocaleDateString('uk-UA')
</script>
<template>
  <div>
    <div class="head">
      <h1>{{ t('admin.nav.requests') }}</h1>
      <div class="tabs">
        <button type="button" :class="['tab', { on: view === 'queue' }]" @click="view = 'queue'">{{ t('dev.reqViewQueue') }}</button>
        <button type="button" :class="['tab', { on: view === 'table' }]" @click="view = 'table'">{{ t('dev.reqViewTable') }}</button>
      </div>
    </div>

    <template v-if="view === 'queue'">
      <p v-if="error" class="error">{{ error }}</p>
      <p v-if="data.external.length + data.career.length === 0" class="sub">{{ t('dev.noPending') }}</p>
      <div class="list">
        <div v-for="r in data.external" :key="r.id" class="card">
          <div class="row"><b>{{ r.fullName }}</b><span class="badge">{{ t(`dev.reqStatus.${r.status}`) }}</span></div>
          <div>{{ t('dev.external') }}: <b>{{ r.title }}</b><span v-if="r.provider"> · {{ r.provider }}</span> · {{ r.format }}<span v-if="r.cost"> · {{ r.cost }} {{ r.currency }}</span></div>
          <p v-if="r.justification" class="sub">{{ r.justification }}</p>
          <input v-model="comment[r.id]" class="field" :placeholder="t('dev.commentPh')">
          <div class="row"><button class="primary" @click="decide('external', r.id, 'approve')">{{ t('dev.approve') }}</button><button class="chip" @click="decide('external', r.id, 'reject')">{{ t('dev.reject') }}</button></div>
        </div>
        <div v-for="r in data.career" :key="r.id" class="card">
          <div class="row"><b>{{ r.fullName }}</b><span class="badge">{{ t(`dev.reqStatus.${r.status}`) }}</span></div>
          <div>{{ t('dev.career') }}: <b>{{ r.targetPosition }}</b></div>
          <p v-if="r.motivation" class="sub">{{ r.motivation }}</p>
          <input v-model="comment[r.id]" class="field" :placeholder="t('dev.commentPh')">
          <div class="row"><button class="primary" @click="decide('career', r.id, 'approve')">{{ t('dev.approve') }}</button><button class="chip" @click="decide('career', r.id, 'reject')">{{ t('dev.reject') }}</button></div>
        </div>
      </div>
    </template>

    <template v-else>
      <p v-if="tableError" class="error">{{ tableError }}</p>
      <div class="filters">
        <select v-model="filters.kind" class="field" :aria-label="t('dev.reqAllKinds')">
          <option value="">{{ t('dev.reqAllKinds') }}</option>
          <option value="external">{{ t('dev.external') }}</option>
          <option value="career">{{ t('dev.career') }}</option>
        </select>
        <select v-model="filters.status" class="field" :aria-label="t('dev.reqCol.status')">
          <option value="">{{ t('dev.allStatuses') }}</option>
          <option v-for="s in STATUSES" :key="s" :value="s">{{ t(`dev.reqStatus.${s}`) }}</option>
        </select>
        <label class="sub">{{ t('reports.from') }} <input v-model="filters.from" type="date" class="field"></label>
        <label class="sub">{{ t('reports.to') }} <input v-model="filters.to" type="date" class="field"></label>
      </div>
      <div class="table-wrap">
        <table class="table">
          <thead><tr><th>{{ t('dev.reqCol.title') }}</th><th>{{ t('dev.reqCol.person') }}</th><th>{{ t('dev.reqCol.cost') }}</th><th>{{ t('kb.owner') }}</th><th>{{ t('dev.reqCol.date') }}</th><th>{{ t('dev.reqCol.status') }}</th></tr></thead>
          <tbody>
            <tr v-for="r in rows" :key="`${r.kind}:${r.id}`">
              <td><b>{{ r.title }}</b><div class="sub">{{ t(`dev.${r.kind}`) }}</div></td>
              <td>{{ r.fullName }}</td>
              <td>{{ r.cost ? `${r.cost} ${r.currency}` : '—' }}</td>
              <td>{{ r.responsible ?? '—' }}</td>
              <td class="muted">{{ fmt(r.createdAt) }}</td>
              <td><span :class="['badge', r.status]">{{ t(`dev.reqStatus.${r.status}`) }}</span></td>
            </tr>
            <tr v-if="rows.length === 0"><td colspan="6" class="empty">{{ t('dev.reqNoRows') }}</td></tr>
          </tbody>
        </table>
      </div>
    </template>
  </div>
</template>
<style scoped>
.head { display: flex; align-items: center; justify-content: space-between; gap: var(--space-3); flex-wrap: wrap; margin: 0 0 var(--space-4); }
h1 { margin: 0; font-weight: 900; }
.tabs { display: flex; gap: var(--space-1); }
.tab { font: inherit; font-weight: 700; border: 1px solid var(--color-bg-line); background: var(--color-bg); color: var(--color-ink-muted); border-radius: var(--radius-pill); padding: var(--space-2) var(--space-4); cursor: pointer; }
.tab.on { background: var(--color-sun); color: var(--color-ink); border-color: transparent; }
.list { display: grid; gap: var(--space-2); }
.card { background: var(--color-bg-soft); border-radius: var(--radius-l); padding: var(--space-3); display: grid; gap: var(--space-2); }
.row { display: flex; gap: var(--space-2); align-items: center; justify-content: space-between; flex-wrap: wrap; }
.field { font: inherit; border: 1px solid var(--color-bg-line); border-radius: var(--radius-s); padding: var(--space-2) var(--space-3); background: var(--color-bg); color: var(--color-ink); }
.chip { font: inherit; font-size: var(--font-size-body-s); font-weight: 700; border: 1px solid var(--color-bg-line); background: transparent; color: var(--color-ink-muted); border-radius: var(--radius-pill); padding: var(--space-1) var(--space-3); cursor: pointer; }
.primary { font: inherit; font-weight: 800; border: none; background: var(--color-sun); color: var(--color-ink); border-radius: var(--radius-pill); padding: var(--space-2) var(--space-4); cursor: pointer; }
.badge { font-size: var(--font-size-body-s); font-weight: 700; border-radius: var(--radius-pill); padding: 2px var(--space-3); background: var(--color-bg-line-soft); }
.badge.approved, .badge.completed { background: var(--color-teal); color: var(--color-teal-deep); }
.badge.rejected { background: var(--color-coral); color: var(--color-coral-deep); }
.sub { font-size: var(--font-size-body-s); color: var(--color-ink-faint); margin: 0; }
.error { color: var(--color-coral-ink); }
.filters { display: flex; gap: var(--space-2); align-items: center; flex-wrap: wrap; margin-bottom: var(--space-3); }
.muted { color: var(--color-ink-faint); }
.empty { color: var(--color-ink-faint); text-align: center; padding: var(--space-6); }
</style>
