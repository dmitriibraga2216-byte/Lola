<script setup lang="ts">
definePageMeta({ layout: 'admin', middleware: 'admin-scope', requiredScope: 'assignment.create' })

const { t } = useI18n()
const { api } = useApi()
const { hasScope } = useAuth()
const route = useRoute()
const id = route.params.id as string

interface Person { enrollmentId: string, userId: string, fullName: string, status: string, progressPct: string, dueAt: string | null, completedAt: string | null, lastActivityAt: string | null }
interface A {
  id: string, title: string, kind: string, status: string, isMandatory: boolean, dueMode: string, dueAt: string | null, dueDays: number | null,
  autoSync: boolean, createdAt: string, lastSyncAt: string | null,
  stats: { assigned?: number, started?: number, completed?: number, overdue?: number }
  people: Person[]
}

const a = ref<A | null>(null)
const error = ref('')
const notice = ref('')
const statusFilter = ref('')
const extendFor = ref<Person | null>(null)
const extendForm = reactive({ dueAt: '', reason: '' })

async function load() {
  try {
    a.value = await api<A>(`/assignments/${id}`)
  }
  catch (err) {
    error.value = apiErrorOf(err).message
  }
}
onMounted(load)

const people = computed(() => (a.value?.people ?? []).filter(p => !statusFilter.value || p.status === statusFilter.value))
const started = computed(() => (a.value?.people ?? []).filter(p => ['in_progress', 'failed', 'expired'].includes(p.status)).length)

async function setStatus(status: string) {
  await api(`/assignments/${id}`, { method: 'PATCH', body: { status } })
  await load()
}

async function cancel() {
  const reason = prompt(t('assign.cancelReason'))
  if (!reason || reason.length < 3) return
  const keepStarted = started.value === 0 || confirm(t('assign.cancelKeep', { n: started.value }))
  const r = await api<{ removed: number, cancelled: number }>(`/assignments/${id}/cancel`, { method: 'POST', body: { reason, keepStarted } })
  notice.value = t('assign.cancelled', { removed: r.removed, cancelled: r.cancelled })
  await load()
}

async function extend() {
  if (!extendFor.value) return
  error.value = ''
  try {
    await api(`/manage/enrollments/${extendFor.value.enrollmentId}/extend`, {
      method: 'POST',
      body: { dueAt: new Date(extendForm.dueAt).toISOString(), reason: extendForm.reason, notify: true },
    })
    notice.value = t('common.saved')
    extendFor.value = null
    await load()
  }
  catch (err) {
    error.value = apiErrorOf(err).message
  }
}

const fmt = (d: string | null) => d ? new Date(d).toLocaleDateString('uk') : '—'
</script>

<template>
  <div v-if="a">
    <NuxtLink to="/admin/assignments" class="back">← {{ t('admin.nav.assignments') }}</NuxtLink>
    <header class="head">
      <h1>{{ a.title }}</h1>
      <span :class="['badge', a.status]">{{ t(`assign.status.${a.status}`) }}</span>
      <span class="sub">{{ t(`assign.kind.${a.kind}`) }} · {{ fmt(a.createdAt) }}</span>
      <div class="actions">
        <button v-if="a.status === 'active'" class="chip" @click="setStatus('paused')">{{ t('assign.pause') }}</button>
        <button v-if="a.status === 'paused'" class="chip" @click="setStatus('active')">{{ t('assign.resume') }}</button>
        <button v-if="hasScope('assignment.cancel') && a.status !== 'archived'" class="chip danger" @click="cancel">{{ t('assign.cancel') }}</button>
      </div>
    </header>

    <p v-if="error" class="error">{{ error }}</p>
    <p v-if="notice" class="notice">{{ notice }}</p>

    <div class="kpis">
      <div class="kpi"><b>{{ a.stats.assigned ?? 0 }}</b><span>{{ t('assign.kpi.assigned') }}</span></div>
      <div class="kpi"><b>{{ a.stats.started ?? 0 }}</b><span>{{ t('assign.kpi.started') }}</span></div>
      <div class="kpi teal"><b>{{ a.stats.completed ?? 0 }}</b><span>{{ t('assign.kpi.completed') }}</span></div>
      <div class="kpi coral"><b>{{ a.stats.overdue ?? 0 }}</b><span>{{ t('assign.kpi.overdue') }}</span></div>
    </div>

    <div class="filter">
      <select v-model="statusFilter">
        <option value="">{{ t('assign.allStatuses') }}</option>
        <option v-for="s in ['not_started', 'in_progress', 'completed', 'expired', 'failed', 'cancelled']" :key="s" :value="s">{{ t(`enrollment.${s}`) }}</option>
      </select>
      <span class="sub">{{ t('assign.autoSyncState', { on: a.autoSync ? '✓' : '—', at: fmt(a.lastSyncAt) }) }}</span>
    </div>

    <table class="table">
      <thead><tr><th>{{ t('people.col.name') }}</th><th>{{ t('assign.col.status') }}</th><th>%</th><th>{{ t('assign.col.due') }}</th><th>{{ t('people.col.lastSeen') }}</th><th /></tr></thead>
      <tbody>
        <tr v-for="p in people" :key="p.enrollmentId">
          <td><NuxtLink :to="`/admin/people/${p.userId}`" class="link">{{ p.fullName }}</NuxtLink></td>
          <td><span :class="['badge', p.status]">{{ t(`enrollment.${p.status}`) }}</span></td>
          <td>{{ Number(p.progressPct) }}</td>
          <td :class="{ coral: p.status === 'expired' }">{{ fmt(p.dueAt) }}</td>
          <td class="sub">{{ fmt(p.lastActivityAt) }}</td>
          <td><button v-if="p.status !== 'completed' && p.status !== 'cancelled'" class="chip" @click="extendFor = p; extendForm.dueAt = ''; extendForm.reason = ''">{{ t('assign.extend') }}</button></td>
        </tr>
      </tbody>
    </table>

    <div v-if="extendFor" class="modal-backdrop" @click.self="extendFor = null">
      <div class="modal">
        <h2>{{ t('assign.extendTitle', { name: extendFor.fullName }) }}</h2>
        <label>{{ t('assign.newDue') }} <input v-model="extendForm.dueAt" type="datetime-local"></label>
        <label>{{ t('assign.reason') }} <input v-model="extendForm.reason" :placeholder="t('assign.reasonHint')"></label>
        <div class="modal-actions">
          <button class="chip" @click="extendFor = null">{{ t('common.cancel') }}</button>
          <button class="primary" :disabled="!extendForm.dueAt || extendForm.reason.length < 5" @click="extend">{{ t('assign.extend') }}</button>
        </div>
      </div>
    </div>
  </div>
  <p v-else-if="error" class="error">{{ error }}</p>
</template>

<style scoped>
.back { color: var(--color-ink-muted); text-decoration: none; font-size: var(--font-size-body-s); }
.head { display: flex; align-items: center; gap: var(--space-3); flex-wrap: wrap; margin: var(--space-2) 0 var(--space-4); }
h1 { margin: 0; font-weight: 900; }
.actions { margin-left: auto; display: flex; gap: var(--space-2); }
.kpis { display: flex; gap: var(--space-3); margin-bottom: var(--space-4); flex-wrap: wrap; }
.kpi { background: var(--color-bg-soft); border-radius: var(--radius-m); padding: var(--space-3) var(--space-5); display: grid; text-align: center; min-width: 100px; }
.kpi b { font-size: var(--font-size-title-l); font-weight: 900; }
.kpi span { font-size: var(--font-size-body-s); color: var(--color-ink-muted); }
.kpi.teal b { color: var(--color-teal-ink); }
.kpi.coral b { color: var(--color-coral-ink); }
.filter { display: flex; gap: var(--space-4); align-items: center; margin-bottom: var(--space-3); }
select, input { font: inherit; border: 1px solid var(--color-bg-line); border-radius: var(--radius-s); padding: var(--space-1) var(--space-3); background: var(--color-bg-soft); color: var(--color-ink); }
.table { width: 100%; border-collapse: collapse; background: var(--color-bg-soft); border-radius: var(--radius-m); overflow: hidden; }
th { text-align: left; font-size: var(--font-size-body-s); color: var(--color-ink-muted); padding: var(--space-2) var(--space-3); border-bottom: 1px solid var(--color-bg-line); }
td { padding: var(--space-2) var(--space-3); border-bottom: 1px solid var(--color-bg-line-soft); }
.link { color: var(--color-ink); font-weight: 700; text-decoration: none; }
.chip { font: inherit; font-size: var(--font-size-body-s); font-weight: 700; border: 1px solid var(--color-bg-line); background: transparent; color: var(--color-ink-muted); border-radius: var(--radius-pill); padding: var(--space-1) var(--space-3); cursor: pointer; }
.chip.danger { color: var(--color-coral-ink); }
.primary { font: inherit; font-weight: 800; border: none; background: var(--color-sun); color: var(--color-ink); border-radius: var(--radius-pill); padding: var(--space-2) var(--space-4); cursor: pointer; }
.primary:disabled { opacity: 0.5; }
.badge { font-size: var(--font-size-body-s); font-weight: 700; border-radius: var(--radius-pill); padding: 2px var(--space-3); background: var(--color-bg-line-soft); }
.badge.active, .badge.completed { background: var(--color-teal); color: var(--color-teal-deep); }
.badge.paused, .badge.in_progress { background: var(--color-sun); color: var(--color-sun-ink); }
.badge.expired, .badge.failed { background: var(--color-coral); color: var(--color-coral-deep); }
.coral { color: var(--color-coral-ink); font-weight: 700; }
.sub { font-size: var(--font-size-body-s); color: var(--color-ink-faint); }
.error { color: var(--color-coral-ink); }
.notice { color: var(--color-teal-ink); }
.modal-backdrop { position: fixed; inset: 0; z-index: 20; overflow: auto; background: rgb(12 15 20 / 40%); display: grid; place-items: center; padding: var(--space-4); }
.modal { background: var(--color-bg-soft); border-radius: var(--radius-xl); padding: var(--space-5); width: min(420px, 100%); box-sizing: border-box; display: grid; gap: var(--space-3); }
.modal h2 { margin: 0; font-weight: 900; font-size: var(--font-size-title-l); }
.modal label { display: grid; gap: var(--space-1); font-size: var(--font-size-body-s); color: var(--color-ink-muted); }
.modal-actions { display: flex; flex-wrap: wrap; justify-content: flex-end; gap: var(--space-2); }
</style>
