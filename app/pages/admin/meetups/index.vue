<script setup lang="ts">
definePageMeta({ layout: 'admin', middleware: 'admin-scope', requiredScope: 'meetup.manage' })
const { t } = useI18n()
const { api } = useApi()
const { hasScope } = useAuth()
interface M { id: string, kind: string, title: string, starts_at: string, ends_at: string, status: string, location: string | null, trainers: string[], registered: number, waitlist: number, capacity: number | null }
const items = ref<M[]>([])
const locations = ref<{ id: string, name: string }[]>([])
const people = ref<{ id: string, fullName: string }[]>([])
const surveys = ref<{ id: string, title: string }[]>([])
const error = ref('')
const notice = ref('')
const form = reactive({ kind: 'meetup', title: '', startsAt: '', endsAt: '', locationId: '', room: '', address: '', trainerIds: [] as string[], capacity: null as number | null, waitlistEnabled: true, enrollDeadlineHours: 2, cancelDeadlineHours: 24, attendanceMode: 'both', requiresFeedback: true, feedbackSurveyId: '', program: '', provider: 'meet', joinUrl: '', minMinutes: null as number | null })
async function load() {
  try {
    items.value = await api<M[]>(`/meetups?from=${new Date(Date.now() - 30 * 86_400_000).toISOString().slice(0, 10)}&to=${new Date(Date.now() + 365 * 86_400_000).toISOString().slice(0, 10)}`)
    locations.value = await api('/refs/locations'); people.value = await api('/people?limit=100'); surveys.value = await api('/surveys')
  } catch (err) { error.value = apiErrorOf(err).message }
}
onMounted(load)
async function create() {
  error.value = ''; notice.value = ''
  try {
    const body: Record<string, unknown> = { kind: form.kind, title: form.title, startsAt: new Date(form.startsAt).toISOString(), endsAt: new Date(form.endsAt).toISOString(), locationId: form.locationId || null, room: form.room || null, address: form.address || null, trainerIds: form.trainerIds, capacity: form.capacity || null, waitlistEnabled: form.waitlistEnabled, enrollDeadlineHours: form.enrollDeadlineHours, cancelDeadlineHours: form.cancelDeadlineHours, attendanceMode: form.attendanceMode, requiresFeedback: form.requiresFeedback, feedbackSurveyId: form.feedbackSurveyId || null, description: form.program ? [{ id: 'p', type: 'text', html: `<p>${form.program.replace(/\n/g, '<br>')}</p>` }] : [] }
    if (form.kind === 'webinar') body.webinar = { provider: form.provider, joinUrl: form.joinUrl || null, minMinutesForAttendance: form.minMinutes }
    const m = await api<{ id: string }>('/meetups', { method: 'POST', body })
    notice.value = t('common.saved'); form.title = ''
    await navigateTo(`/admin/meetups/${m.id}`)
  } catch (err) { error.value = apiErrorOf(err).message }
}
const fmt = (d: string) => new Date(d).toLocaleString('uk-UA', { dateStyle: 'short', timeStyle: 'short' })
</script>
<template>
  <div>
    <h1>{{ t('admin.nav.meetups') }}</h1>
    <p v-if="error" class="error">{{ error }}</p>
    <p v-if="notice" class="notice">{{ notice }}</p>
    <table class="table">
      <thead><tr><th>{{ t('assign.col.title') }}</th><th>{{ t('mt.when') }}</th><th>{{ t('mt.trainer') }}</th><th>{{ t('mt.participants') }}</th><th>{{ t('assign.col.status') }}</th></tr></thead>
      <tbody>
        <tr v-for="m in items" :key="m.id">
          <td><NuxtLink :to="`/admin/meetups/${m.id}`" class="link">{{ m.kind === 'webinar' ? '🎥 ' : '' }}{{ m.title }}</NuxtLink><div class="sub">{{ m.location ?? '' }}</div></td>
          <td class="sub">{{ fmt(m.starts_at) }}</td><td class="sub">{{ m.trainers.join(', ') }}</td>
          <td>{{ m.registered }}<template v-if="m.capacity"> / {{ m.capacity }}</template><span v-if="m.waitlist" class="sub"> +{{ m.waitlist }} {{ t('mt.queue') }}</span></td>
          <td><span :class="['badge', m.status]">{{ t(`mt.mstatus.${m.status}`) }}</span></td>
        </tr>
      </tbody>
    </table>
    <section class="card">
      <h2>{{ t('mt.new') }}</h2>
      <div class="row">
        <select v-model="form.kind" class="field"><option value="meetup">{{ t('mt.kind.meetup') }}</option><option v-if="hasScope('webinar.manage')" value="webinar">{{ t('mt.kind.webinar') }}</option></select>
        <input v-model="form.title" class="field grow" :placeholder="t('mt.titlePh')" data-testid="mt-title">
      </div>
      <div class="row">
        <label class="sub">{{ t('mt.start') }} <input v-model="form.startsAt" class="field" type="datetime-local" data-testid="mt-start"></label>
        <label class="sub">{{ t('mt.end') }} <input v-model="form.endsAt" class="field" type="datetime-local" data-testid="mt-end"></label>
      </div>
      <div v-if="form.kind === 'meetup'" class="row">
        <select v-model="form.locationId" class="field"><option value="">{{ t('mt.noLocation') }}</option><option v-for="l in locations" :key="l.id" :value="l.id">{{ l.name }}</option></select>
        <input v-model="form.room" class="field" :placeholder="t('mt.room')" maxlength="120">
        <input v-model="form.address" class="field grow" :placeholder="t('mt.address')">
      </div>
      <div v-else class="row">
        <select v-model="form.provider" class="field"><option value="zoom">Zoom</option><option value="meet">Google Meet</option><option value="other">{{ t('mt.other') }}</option></select>
        <input v-model="form.joinUrl" class="field grow" :placeholder="t('mt.joinUrl')">
        <label class="sub">{{ t('mt.minMinutes') }} <input v-model.number="form.minMinutes" class="field short" type="number" min="1"></label>
      </div>
      <label class="sub">{{ t('mt.trainers') }}</label>
      <div class="row"><label v-for="p in people" :key="p.id" class="check"><input v-model="form.trainerIds" type="checkbox" :value="p.id"> {{ p.fullName }}</label></div>
      <div class="row">
        <label class="sub">{{ t('mt.capacity') }} <input v-model.number="form.capacity" class="field short" type="number" min="1" max="500" data-testid="mt-capacity"></label>
        <label class="check"><input v-model="form.waitlistEnabled" type="checkbox"> {{ t('mt.waitlist') }}</label>
        <label class="sub">{{ t('mt.enrollDeadline') }} <input v-model.number="form.enrollDeadlineHours" class="field short" type="number" min="0" max="720"></label>
        <label class="sub">{{ t('mt.cancelDeadline') }} <input v-model.number="form.cancelDeadlineHours" class="field short" type="number" min="0" max="720"></label>
      </div>
      <div class="row">
        <span class="sub">{{ t('mt.attendance') }}:</span>
        <label v-for="mode in ['manual', 'qr', 'both']" :key="mode" class="check"><input v-model="form.attendanceMode" type="radio" :value="mode"> {{ t(`mt.mode.${mode}`) }}</label>
        <label class="check"><input v-model="form.requiresFeedback" type="checkbox"> {{ t('mt.feedback') }}</label>
        <select v-if="form.requiresFeedback" v-model="form.feedbackSurveyId" class="field"><option value="">{{ t('mt.defaultSurvey') }}</option><option v-for="s in surveys" :key="s.id" :value="s.id">{{ s.title }}</option></select>
      </div>
      <textarea v-model="form.program" class="field" rows="3" :placeholder="t('mt.programPh')" />
      <button class="primary" :disabled="form.title.length < 3 || !form.startsAt || !form.endsAt || !form.trainerIds.length" data-testid="mt-create" @click="create">{{ t('common.save') }}</button>
    </section>
  </div>
</template>
<style scoped>
h1 { margin: 0 0 var(--space-4); font-weight: 900; }
h2 { margin: 0; font-weight: 800; }
.table { width: 100%; border-collapse: collapse; background: var(--color-bg-soft); border-radius: var(--radius-m); overflow: hidden; margin-bottom: var(--space-4); }
th { text-align: left; font-size: var(--font-size-body-s); color: var(--color-ink-muted); padding: var(--space-2) var(--space-3); border-bottom: 1px solid var(--color-bg-line); }
td { padding: var(--space-2) var(--space-3); border-bottom: 1px solid var(--color-bg-line-soft); vertical-align: top; }
.link { color: var(--color-ink); font-weight: 700; }
.card { background: var(--color-bg-soft); border-radius: var(--radius-l); padding: var(--space-4); display: grid; gap: var(--space-3); }
.field, select, textarea { font: inherit; border: 1px solid var(--color-bg-line); border-radius: var(--radius-s); padding: var(--space-2) var(--space-3); background: var(--color-bg); color: var(--color-ink); }
.short { width: 70px; }
.grow { flex: 1; min-width: 160px; }
.row { display: flex; gap: var(--space-2); align-items: center; flex-wrap: wrap; }
.check { display: flex; gap: var(--space-1); align-items: center; font-size: var(--font-size-body-s); }
.primary { font: inherit; font-weight: 800; border: none; background: var(--color-sun); color: var(--color-ink); border-radius: var(--radius-pill); padding: var(--space-2) var(--space-4); cursor: pointer; justify-self: start; }
.primary:disabled { opacity: 0.5; }
.badge { font-size: var(--font-size-body-s); font-weight: 700; border-radius: var(--radius-pill); padding: 2px var(--space-3); background: var(--color-bg-line-soft); }
.badge.planned { background: var(--color-teal); color: var(--color-teal-deep); }
.badge.ongoing { background: var(--color-sun); color: var(--color-sun-ink); }
.badge.cancelled { background: var(--color-coral); color: var(--color-coral-deep); }
.sub { font-size: var(--font-size-body-s); color: var(--color-ink-faint); }
.error { color: var(--color-coral-ink); }
.notice { color: var(--color-teal-ink); }
</style>
