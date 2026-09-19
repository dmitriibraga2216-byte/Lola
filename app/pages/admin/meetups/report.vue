<script setup lang="ts">
definePageMeta({ layout: 'admin', middleware: 'admin-scope', requiredScope: 'report.team' })
const { t } = useI18n()
const { api } = useApi()
interface Rep { meetups: { id: string, title: string, starts_at: string, status: string, registered: number, attended: number, missed_names: string | null }[], byTrainer: { trainer: string, meetups: number, avg_attendance: string | null }[], byPerson: { full_name: string, missed: number }[], complex: { title: string, part: string, attempts: number, avg_score: string, failed: number }[] }
const rep = ref<Rep | null>(null)
const error = ref('')
onMounted(async () => { try { rep.value = await api('/reports/attendance') } catch (err) { error.value = apiErrorOf(err).message } })
const fmt = (d: string) => new Date(d).toLocaleDateString('uk-UA')
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
