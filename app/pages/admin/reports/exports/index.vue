<script setup lang="ts">
const { formatDateTime } = useFormat()
definePageMeta({ layout: 'admin', middleware: 'admin-scope', requiredScope: 'report.team' })
const { t } = useI18n()
const { api } = useApi()
interface E { id: string, report: string, status: string, rows: number | null, createdAt: string, expiresAt: string | null, format: string }
const items = ref<E[]>([])
const error = ref('')
async function load() { try { items.value = await api('/exports') } catch (err) { error.value = apiErrorOf(err).message } }
onMounted(load)
let timer: ReturnType<typeof setInterval>
onMounted(() => { timer = setInterval(() => { if (items.value.some(e => e.status === 'queued' || e.status === 'running')) load() }, 4000) })
onUnmounted(() => clearInterval(timer))
async function open(e: E) {
  try { const r = await api<{ url: string | null, expired: boolean }>(`/exports/${e.id}`); if (r.url) window.open(r.url, '_blank'); else error.value = t('reports.exportExpired') }
  catch (err) { error.value = apiErrorOf(err).message }
}
const fmt = (d: string | null) => d ? formatDateTime(new Date(d)) : '—'
</script>
<template>
  <div>
    <NuxtLink to="/admin/reports" class="back">← {{ t('admin.nav.reports') }}</NuxtLink>
    <h1>{{ t('reports.myExports') }}</h1>
    <p v-if="error" class="error" role="alert">{{ error }}</p>
    <p v-if="items.length === 0" class="sub">{{ t('person.noData') }}</p>
    <table v-else class="table">
      <thead><tr><th>{{ t('reports.report') }}</th><th>{{ t('assign.col.status') }}</th><th>{{ t('reports.rows') }}</th><th>{{ t('people.col.registered') }}</th><th>{{ t('mystery.expires') }}</th><th /></tr></thead>
      <tbody>
        <tr v-for="e in items" :key="e.id">
          <td><b>{{ t(`reports.${e.report}`, e.report) }}</b> <span class="sub">{{ e.format }}</span></td>
          <td><span :class="['badge', e.status]">{{ t(`reports.exportStatus.${e.status}`) }}</span></td>
          <td>{{ e.rows ?? '—' }}</td><td class="sub">{{ fmt(e.createdAt) }}</td><td class="sub">{{ fmt(e.expiresAt) }}</td>
          <td><button v-if="e.status === 'ready'" class="chip" @click="open(e)">{{ t('reports.download') }}</button></td>
        </tr>
      </tbody>
    </table>
  </div>
</template>
<style scoped>
.back { color: var(--color-ink-muted); text-decoration: none; font-size: var(--font-size-body-s); }
h1 { margin: var(--space-2) 0 var(--space-3); font-weight: 900; }
.table { width: 100%; border-collapse: collapse; background: var(--color-bg-soft); border-radius: var(--radius-m); overflow: hidden; }
th { text-align: left; font-size: var(--font-size-body-s); color: var(--color-ink-muted); padding: var(--space-2) var(--space-3); border-bottom: 1px solid var(--color-bg-line); }
td { padding: var(--space-2) var(--space-3); border-bottom: 1px solid var(--color-bg-line-soft); }
.badge { font-size: var(--font-size-body-s); font-weight: 700; border-radius: var(--radius-pill); padding: 2px var(--space-3); background: var(--color-bg-line-soft); }
.badge.ready { background: var(--color-teal); color: var(--color-teal-deep); }
.badge.failed { background: var(--color-coral); color: var(--color-coral-deep); }
.badge.running, .badge.queued { background: var(--color-sun); color: var(--color-sun-ink); }
.chip { font: inherit; font-size: var(--font-size-body-s); font-weight: 700; border: 1px solid var(--color-bg-line); background: transparent; color: var(--color-ink); border-radius: var(--radius-pill); padding: var(--space-1) var(--space-3); cursor: pointer; }
.sub { font-size: var(--font-size-body-s); color: var(--color-ink-faint); }
.error { color: var(--color-coral-ink); }
</style>
