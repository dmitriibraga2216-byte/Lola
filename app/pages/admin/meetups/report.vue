<script setup lang="ts">
import type { FrameRow } from '~/components/ReportFrame.vue'
const { formatDateTime, formatShortDate } = useFormat()
definePageMeta({ layout: 'admin', middleware: 'admin-scope', requiredScope: 'report.team' })
const { t } = useI18n()
const { api } = useApi()
type PersonRow = FrameRow & { session_id: string, meetup_id: string, session_title: string, kind: string, session_at: string, session_place: string | null, registration_status: string, presence: string | null, marked_by: string | null, marked_at: string | null, joined_at: string | null, left_at: string | null, minutes_watched: number | null, watch_pct: string | null }
interface Rep { meetups: { id: string, title: string, starts_at: string, status: string, registered: number, attended: number, missed_names: string | null }[], byTrainer: { trainer: string, meetups: number, avg_attendance: string | null }[], byPerson: { full_name: string, missed: number }[], people: PersonRow[], complex: { title: string, part: string, attempts: number, avg_score: string, failed: number }[] }
const rep = ref<Rep | null>(null)
const error = ref('')
onMounted(async () => { try { rep.value = await api('/reports/attendance') } catch (err) { error.value = apiErrorOf(err).message } })
const fmt = (d: string) => formatShortDate(new Date(d))
const fmtAt = (d: string | null) => d ? formatDateTime(new Date(d), { day: '2-digit', month: '2-digit', year: 'numeric', hour: '2-digit', minute: '2-digit' }) : '—'
</script>
<template>
  <div>
    <h1>{{ t('admin.nav.attendanceReport') }}</h1>
    <p v-if="error" class="error">{{ error }}</p>
    <template v-if="rep">
      <section class="card">
        <h2>{{ t('mt.reportAttendance') }}</h2>
        <table class="table plain"><thead><tr><th>{{ t('assign.col.title') }}</th><th>{{ t('cl.date') }}</th><th>{{ t('mt.registeredShort') }}</th><th>{{ t('mt.came') }}</th><th>%</th><th>{{ t('mt.missedList') }}</th></tr></thead>
          <tbody><tr v-for="m in rep.meetups" :key="m.id"><td><NuxtLink :to="`/admin/meetups/${m.id}`" class="link">{{ m.title }}</NuxtLink></td><td>{{ fmt(m.starts_at) }}</td><td>{{ m.registered }}</td><td>{{ m.attended }}</td><td>{{ m.registered ? Math.round(m.attended / m.registered * 100) : 0 }}</td><td class="sub">{{ m.missed_names ?? '' }}</td></tr></tbody></table>
      </section>
      <!-- docs/18 Г-18.2, docs/33 D-030: люди × сесії на єдиному каркасі звітів -->
      <section class="card">
        <h2>{{ t('mt.reportSessionsPeople') }}</h2>
        <div class="table-wrap">
          <table v-if="rep.people?.length" class="table plain">
            <thead><tr>
              <ReportFrame part="head" />
              <th>{{ t('mt.col.session') }}</th><th>{{ t('mt.col.regStatus') }}</th><th>{{ t('mt.col.presence') }}</th><th>{{ t('mt.col.markedBy') }}</th><th>{{ t('mt.col.markedAt') }}</th><th class="num">{{ t('mt.col.minutes') }}</th>
            </tr></thead>
            <tbody>
              <tr v-for="p in rep.people" :key="`${p.session_id}-${p.user_id}`">
                <ReportFrame part="cells" :row="p" />
                <td><NuxtLink :to="`/admin/meetups/${p.meetup_id}`" class="link">{{ p.session_title }}</NuxtLink><span class="sub"> {{ fmtAt(p.session_at) }}<template v-if="p.session_place"> · {{ p.session_place }}</template></span></td>
                <td>{{ t(`mt.reg.${p.registration_status}`) }}</td>
                <td>{{ p.presence ? t(`mt.presence.${p.presence}`) : '—' }}</td>
                <td>{{ p.marked_by ?? '—' }}</td>
                <td>{{ fmtAt(p.marked_at) }}</td>
                <td class="num">{{ p.kind === 'webinar' ? `${p.minutes_watched ?? 0} (${p.watch_pct ?? 0}%)` : '—' }}</td>
              </tr>
            </tbody>
          </table>
          <p v-else class="sub">{{ t('reports.noData') }}</p>
        </div>
      </section>
      <section class="card">
        <h2>{{ t('mt.reportTrainers') }}</h2>
        <table class="table plain"><tbody><tr v-for="tr in rep.byTrainer" :key="tr.trainer"><td>{{ tr.trainer }}</td><td>{{ tr.meetups }}</td><td>{{ tr.avg_attendance ?? '—' }}%</td></tr></tbody></table>
      </section>
      <section class="card">
        <h2>{{ t('mt.reportPeople') }}</h2>
        <table class="table plain"><tbody><tr v-for="p in rep.byPerson" :key="p.full_name"><td>{{ p.full_name }}</td><td>{{ p.missed }}</td></tr></tbody></table>
      </section>
      <section class="card">
        <h2>{{ t('cx.report') }}</h2>
        <table class="table plain"><thead><tr><th>{{ t('cx.test') }}</th><th>{{ t('cx.partWord') }}</th><th>{{ t('cx.attemptsCol') }}</th><th>{{ t('cx.avg') }}</th><th>{{ t('cx.failedCol') }}</th></tr></thead>
          <tbody><tr v-for="(c, i) in rep.complex" :key="i"><td>{{ c.title }}</td><td>{{ c.part }}</td><td>{{ c.attempts }}</td><td>{{ c.avg_score }}</td><td :class="{ red: c.failed }">{{ c.failed }}</td></tr></tbody></table>
      </section>
    </template>
  </div>
</template>
<style scoped>
h1 { margin: 0 0 var(--space-3); font-weight: 900; }
h2 { margin: 0; font-weight: 800; }
.card { background: var(--color-bg-soft); border-radius: var(--radius-l); padding: var(--space-4); display: grid; gap: var(--space-2); margin-bottom: var(--space-3); }
.table { width: 100%; border-collapse: collapse; }
th { text-align: left; font-size: var(--font-size-body-s); color: var(--color-ink-muted); padding: var(--space-2); border-bottom: 1px solid var(--color-bg-line); }
td { padding: var(--space-2); border-bottom: 1px solid var(--color-bg-line-soft); vertical-align: top; }
.link { color: var(--color-ink); font-weight: 700; }
.red { color: var(--color-coral-deep); font-weight: 700; }
.sub { font-size: var(--font-size-body-s); color: var(--color-ink-faint); }
.error { color: var(--color-coral-ink); }
</style>
