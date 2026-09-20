<script setup lang="ts">
/** Люди на траектории: статус, текущий шаг, заявки из каталога (рішення), снятие. */
definePageMeta({ layout: 'admin', middleware: 'admin-scope', requiredScope: 'program.manage' })
const { t } = useI18n()
const { api } = useApi()
const { hasScope } = useAuth()
const route = useRoute()
const id = route.params.id as string

interface Row { enrollmentId: string, userId: string, fullName: string, status: string, source: string, progressPct: string, startedAt: string | null, completedAt: string | null, requestedAt: string | null, cancelledAt: string | null, availableFrom: string | null, currentStep: string | null }
const title = ref('')
const rows = ref<Row[]>([])
const error = ref('')
const notice = ref('')
const canDecide = computed(() => hasScope('assignment.create'))

async function load() {
  try {
    const [t, r] = await Promise.all([api<{ title: string }>(`/trajectories/${id}`), api<Row[]>(`/trajectories/${id}/audience`)])
    title.value = t.title; rows.value = r
  }
  catch (err) { error.value = apiErrorOf(err).message }
}
onMounted(load)
async function decide(r: Row, approve: boolean) {
  error.value = ''
  try { await api(`/trajectories/enrollments/${r.enrollmentId}/decide`, { method: 'POST', body: { approve } }); notice.value = t('common.saved'); await load() }
  catch (err) { error.value = apiErrorOf(err).message }
}
async function cancel(r: Row) {
  const reason = prompt(t('traj.cancelReason'))
  if (!reason) return
  try { await api(`/trajectories/enrollments/${r.enrollmentId}/cancel`, { method: 'POST', body: { reason } }); await load() }
  catch (err) { error.value = apiErrorOf(err).message }
}
const fmt = (d: string | null) => d ? new Date(d).toLocaleDateString('uk-UA') : '—'
const stateOf = (r: Row) => r.cancelledAt ? 'cancelled' : r.requestedAt && r.status === 'not_assigned' ? 'requested' : r.status
</script>

<template>
  <div>
    <PageHeader :title="title" :subtitle="t('traj.peopleTitle')" :crumbs="[{ label: t('admin.section.learning') }, { label: t('traj.title'), to: '/admin/trajectories' }, { label: title, to: `/admin/trajectories/${id}` }]" />
    <p v-if="error" class="error-text">{{ error }}</p>
    <p v-if="notice" class="note teal">{{ notice }}</p>
    <div class="table-wrap">
      <table class="table">
        <thead><tr><th>{{ t('traj.col.person') }}</th><th>{{ t('traj.col.state') }}</th><th>{{ t('traj.col.step') }}</th><th>{{ t('traj.col.progress') }}</th><th>{{ t('traj.col.started') }}</th><th /></tr></thead>
        <tbody>
          <tr v-for="r in rows" :key="r.enrollmentId">
            <td><b>{{ r.fullName }}</b><span class="sub">{{ t(`traj.source.${r.source}`) }}<template v-if="r.availableFrom && !r.startedAt"> · {{ t('traj.opensAt', { date: fmt(r.availableFrom) }) }}</template></span></td>
            <td><span :class="['badge', stateOf(r)]">{{ t(`traj.state.${stateOf(r)}`) }}</span></td>
            <td class="muted">{{ r.currentStep ?? '—' }}</td>
            <td class="num">{{ Number(r.progressPct) }}%</td>
            <td class="muted">{{ fmt(r.startedAt) }}</td>
            <td class="acts">
              <NuxtLink :to="`/admin/trajectories/${id}/people/${r.enrollmentId}`" class="chip">{{ t('traj.ladder') }}</NuxtLink>
              <template v-if="canDecide && stateOf(r) === 'requested'">
                <button class="chip" @click="decide(r, true)">{{ t('traj.approve') }}</button>
                <button class="chip coral on" @click="decide(r, false)">{{ t('traj.reject') }}</button>
              </template>
              <button v-if="canDecide && !r.cancelledAt && r.status !== 'done'" class="chip" @click="cancel(r)">{{ t('traj.cancel') }}</button>
            </td>
          </tr>
          <tr v-if="rows.length === 0"><td colspan="6" class="empty">{{ t('traj.noPeople') }}</td></tr>
        </tbody>
      </table>
    </div>
  </div>
</template>

<style scoped>
.acts { display: flex; gap: var(--space-1); flex-wrap: wrap; }
.empty { color: var(--color-ink-faint); text-align: center; padding: var(--space-6); }
.badge.cancelled, .badge.requested { background: var(--color-bg-line-soft); color: var(--color-ink-muted); }
</style>
