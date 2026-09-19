<script setup lang="ts">
import QRCode from 'qrcode'

definePageMeta({ layout: 'admin', middleware: 'admin-scope', requiredScope: 'meetup.attendance' })
const { t } = useI18n()
const { api } = useApi()
const { hasScope } = useAuth()
const route = useRoute()
interface P { id: string, userId: string, fullName: string, status: string, waitlistPosition: number | null, checkInMethod: string | null, checkedInAt: string | null, cancelReason: string | null }
interface M { id: string, kind: string, title: string, startsAt: string, endsAt: string, status: string, attendanceMode: string, capacity: number | null, registered: number, waitlist: number, participants: P[], materials: string[], webinar: { joinUrl: string | null, hostUrl?: string, recordUrl: string | null } | null, location: { name: string } | null, room: string | null }
const m = ref<M | null>(null)
const tab = ref<'participants' | 'qr' | 'materials' | 'summary'>('participants')
const error = ref('')
const notice = ref('')
const qrImg = ref('')
const qrLeft = ref(0)
const cancel = reactive({ open: false, reason: '', notify: true, alternativeId: '' })
const others = ref<{ id: string, fullName: string }[]>([])
const addIds = ref<string[]>([])
const minutes = reactive<Record<string, number>>({})
const recordUrl = ref('')
let qrTimer: ReturnType<typeof setInterval> | null = null
async function load() { try { m.value = await api<M>(`/meetups/${route.params.id}`); recordUrl.value = m.value.webinar?.recordUrl ?? '' } catch (err) { error.value = apiErrorOf(err).message } }
onMounted(async () => { await load(); others.value = await api('/people?limit=100') })
onUnmounted(() => { if (qrTimer) clearInterval(qrTimer) })
async function refreshQr() {
  try { const r = await api<{ token: string, expiresInSec: number }>(`/meetups/${route.params.id}/qr`); qrImg.value = await QRCode.toDataURL(r.token, { width: 480, margin: 1 }); qrLeft.value = r.expiresInSec } catch (err) { error.value = apiErrorOf(err).message }
}
watch(tab, (v) => { if (qrTimer) clearInterval(qrTimer); if (v === 'qr') { refreshQr(); qrTimer = setInterval(() => { qrLeft.value--; if (qrLeft.value <= 0) refreshQr() }, 1000) } })
async function act(fn: () => Promise<unknown>, ok = t('common.saved')) { error.value = ''; notice.value = ''; try { await fn(); notice.value = ok; await load() } catch (err) { error.value = apiErrorOf(err).message } }
const mark = (p: P, status: string) => act(async () => { const reason = status === 'excused' ? prompt(t('mt.excuseReason')) : undefined; if (status === 'excused' && !reason) return; await api(`/meetups/${route.params.id}/attendance`, { method: 'POST', body: { userId: p.userId, status, reason } }) })
const markAll = () => act(async () => { for (const p of m.value!.participants.filter(x => x.status === 'registered')) await api(`/meetups/${route.params.id}/attendance`, { method: 'POST', body: { userId: p.userId, status: 'attended' } }) })
const addOthers = () => act(async () => { await api(`/meetups/${route.params.id}/register-others`, { method: 'POST', body: { userIds: addIds.value } }); addIds.value = [] })
const doCancel = () => act(async () => { await api(`/meetups/${route.params.id}/cancel`, { method: 'POST', body: { reason: cancel.reason, notify: cancel.notify, alternativeId: cancel.alternativeId || null } }); cancel.open = false }, t('mt.cancelledOk'))
const saveMinutes = () => act(() => api(`/meetups/${route.params.id}/participations`, { method: 'POST', body: { source: 'manual', rows: Object.entries(minutes).filter(([, v]) => v >= 0).map(([userId, min]) => ({ userId, minutes: min })) } }))
const saveRecord = () => act(() => api(`/meetups/${route.params.id}`, { method: 'PATCH', body: { webinar: { recordUrl: recordUrl.value || null } } }))
const active = computed(() => m.value?.participants.filter(p => !['cancelled'].includes(p.status)) ?? [])
const attended = computed(() => active.value.filter(p => p.status === 'attended').length)
const fmt = (d: string | null) => d ? new Date(d).toLocaleTimeString('uk-UA', { hour: '2-digit', minute: '2-digit' }) : ''
</script>
<template>
  <div>
    <NuxtLink to="/admin/meetups" class="back">← {{ t('admin.nav.meetups') }}</NuxtLink>
    <p v-if="error" class="error">{{ error }}</p>
    <p v-if="notice" class="notice">{{ notice }}</p>
    <template v-if="m">
      <div class="head"><h1>{{ m.title }}</h1><span :class="['badge', m.status]">{{ t(`mt.mstatus.${m.status}`) }}</span></div>
      <p class="sub">{{ new Date(m.startsAt).toLocaleString('uk-UA', { dateStyle: 'medium', timeStyle: 'short' }) }}<template v-if="m.location"> · {{ m.location.name }}</template><template v-if="m.room">, {{ m.room }}</template> · {{ t('mt.registeredN', { n: m.registered, cap: m.capacity ?? '∞' }) }}<template v-if="m.waitlist"> · {{ t('mt.queue') }}: {{ m.waitlist }}</template></p>
      <div class="tabs">
        <button v-for="tb in ['participants', 'qr', 'materials', 'summary']" :key="tb" :class="['tab', { on: tab === tb }]" :disabled="tb === 'qr' && m.attendanceMode === 'manual'" @click="tab = tb as never">{{ t(`mt.tab.${tb}`) }}</button>
        <span class="spacer" />
        <button v-if="hasScope('meetup.manage') && !['finished', 'cancelled'].includes(m.status)" class="chip danger" @click="cancel.open = true">{{ t('mt.cancelMeetup') }}</button>
      </div>

      <section v-if="tab === 'participants'" class="card">
        <div class="row"><button class="chip" :disabled="!active.some(p => p.status === 'registered')" @click="markAll">{{ t('mt.markAll') }}</button></div>
        <table class="table plain">
          <thead><tr><th>{{ t('people.col.name') }}</th><th>{{ t('assign.col.status') }}</th><th>{{ t('mt.checkin') }}</th><th /></tr></thead>
          <tbody>
            <tr v-for="p in active" :key="p.id" :data-testid="`pt-${p.userId}`">
              <td>{{ p.fullName }}</td>
              <td><span :class="['badge', p.status]">{{ t(`mt.status.${p.status}`) }}<template v-if="p.waitlistPosition"> {{ p.waitlistPosition }}</template></span><div v-if="p.cancelReason" class="sub">{{ p.cancelReason }}</div></td>
              <td class="sub">{{ p.checkedInAt ? `${fmt(p.checkedInAt)} · ${t(`mt.method.${p.checkInMethod}`)}` : '' }}</td>
              <td class="acts">
                <button v-if="p.status !== 'attended'" class="chip" :data-testid="`attend-${p.userId}`" @click="mark(p, 'attended')">{{ t('mt.markPresent') }}</button>
                <button v-if="p.status !== 'missed'" class="chip" @click="mark(p, 'missed')">{{ t('mt.markAbsent') }}</button>
                <button v-if="p.status !== 'excused'" class="chip" @click="mark(p, 'excused')">{{ t('mt.excused') }}</button>
              </td>
            </tr>
          </tbody>
        </table>
        <details>
          <summary class="sub">{{ t('mt.registerOthers') }}</summary>
          <div class="row"><label v-for="u in others.filter(o => !active.some(p => p.userId === o.id))" :key="u.id" class="check"><input v-model="addIds" type="checkbox" :value="u.id"> {{ u.fullName }}</label></div>
          <button class="chip" :disabled="!addIds.length" @click="addOthers">{{ t('mt.add') }}</button>
        </details>
        <details v-if="m.kind === 'webinar'">
          <summary class="sub">{{ t('mt.minutesTitle') }}</summary>
          <div class="row"><label v-for="p in active" :key="p.id" class="check">{{ p.fullName }} <input v-model.number="minutes[p.userId]" class="field short" type="number" min="0" placeholder="хв"></label></div>
          <button class="chip" @click="saveMinutes">{{ t('common.save') }}</button>
        </details>
      </section>

      <section v-else-if="tab === 'qr'" class="card qr">
        <img v-if="qrImg" :src="qrImg" alt="QR" class="qr-img">
        <p class="sub">{{ t('mt.qrHint', { s: qrLeft }) }}</p>
      </section>

      <section v-else-if="tab === 'materials'" class="card">
        <p class="sub">{{ t('mt.materialsHint') }}</p>
        <a v-for="id in m.materials" :key="id" :href="`/api/v1/media/${id}`" target="_blank" class="link">📎 {{ id.slice(0, 8) }}</a>
        <div v-if="m.kind === 'webinar' && hasScope('webinar.manage')" class="row"><input v-model="recordUrl" class="field grow" :placeholder="t('mt.recordUrl')"><button class="chip" @click="saveRecord">{{ t('common.save') }}</button></div>
      </section>

      <section v-else class="card">
        <div class="kpis">
          <div class="kpi"><b>{{ active.filter(p => p.status !== 'waitlist').length }}</b><span>{{ t('mt.registeredShort') }}</span></div>
          <div class="kpi"><b>{{ attended }}</b><span>{{ t('mt.came') }}</span></div>
          <div class="kpi"><b>{{ active.length ? Math.round(attended / active.filter(p => p.status !== 'waitlist').length * 100) || 0 : 0 }}%</b><span>{{ t('mt.attendanceRate') }}</span></div>
        </div>
        <p class="sub">{{ t('mt.missedList') }}: {{ active.filter(p => p.status === 'missed').map(p => p.fullName).join(', ') || '—' }}</p>
      </section>

      <div v-if="cancel.open" class="modal-backdrop" @click.self="cancel.open = false">
        <div class="modal">
          <h2>{{ t('mt.cancelMeetup') }}</h2>
          <textarea v-model="cancel.reason" class="field" rows="3" :placeholder="t('mt.cancelReason')" />
          <label class="check"><input v-model="cancel.notify" type="checkbox"> {{ t('mt.notifyParticipants') }}</label>
          <div class="modal-actions"><button class="chip" @click="cancel.open = false">{{ t('common.cancel') }}</button><button class="primary" :disabled="cancel.reason.trim().length < 10" @click="doCancel">{{ t('mt.cancelConfirm') }}</button></div>
        </div>
      </div>
    </template>
  </div>
</template>
<style scoped>
.back { color: var(--color-ink-muted); text-decoration: none; font-weight: 700; }
.head { display: flex; justify-content: space-between; align-items: center; gap: var(--space-2); margin: var(--space-2) 0 0; }
h1 { margin: 0; font-weight: 900; }
h2 { margin: 0; font-weight: 800; }
.tabs { display: flex; gap: var(--space-1); margin: var(--space-3) 0; align-items: center; flex-wrap: wrap; }
.spacer { flex: 1; }
.tab { font: inherit; font-weight: 700; border: 1px solid var(--color-bg-line); background: transparent; border-radius: var(--radius-pill); padding: var(--space-1) var(--space-3); color: var(--color-ink-muted); cursor: pointer; }
.tab.on { background: var(--color-ink); color: var(--color-bg); border-color: var(--color-ink); }
.tab:disabled { opacity: 0.4; }
.card { background: var(--color-bg-soft); border-radius: var(--radius-l); padding: var(--space-4); display: grid; gap: var(--space-3); }
.card.qr { place-items: center; }
.qr-img { width: min(480px, 100%); image-rendering: pixelated; border-radius: var(--radius-m); background: #fff; }
.table { width: 100%; border-collapse: collapse; }
th { text-align: left; font-size: var(--font-size-body-s); color: var(--color-ink-muted); padding: var(--space-2); border-bottom: 1px solid var(--color-bg-line); }
td { padding: var(--space-2); border-bottom: 1px solid var(--color-bg-line-soft); vertical-align: top; }
.acts { display: flex; gap: var(--space-1); flex-wrap: wrap; }
.row { display: flex; gap: var(--space-2); align-items: center; flex-wrap: wrap; }
.check { display: flex; gap: var(--space-1); align-items: center; font-size: var(--font-size-body-s); }
.field { font: inherit; border: 1px solid var(--color-bg-line); border-radius: var(--radius-s); padding: var(--space-2) var(--space-3); background: var(--color-bg); color: var(--color-ink); }
.short { width: 70px; }
.grow { flex: 1; }
.chip { font: inherit; font-size: var(--font-size-body-s); font-weight: 700; border: 1px solid var(--color-bg-line); background: transparent; color: var(--color-ink-muted); border-radius: var(--radius-pill); padding: var(--space-1) var(--space-3); cursor: pointer; }
.chip.danger { color: var(--color-coral-ink); }
.chip:disabled { opacity: 0.5; }
.primary { font: inherit; font-weight: 800; border: none; background: var(--color-sun); color: var(--color-ink); border-radius: var(--radius-pill); padding: var(--space-2) var(--space-4); cursor: pointer; }
.primary:disabled { opacity: 0.5; }
.badge { font-size: var(--font-size-body-s); font-weight: 700; border-radius: var(--radius-pill); padding: 2px var(--space-3); background: var(--color-bg-line-soft); }
.badge.planned, .badge.attended, .badge.registered { background: var(--color-teal); color: var(--color-teal-deep); }
.badge.ongoing, .badge.waitlist { background: var(--color-sun); color: var(--color-sun-ink); }
.badge.cancelled, .badge.missed { background: var(--color-coral); color: var(--color-coral-deep); }
.kpis { display: flex; gap: var(--space-2); flex-wrap: wrap; }
.kpi { background: var(--color-bg); border-radius: var(--radius-m); padding: var(--space-3) var(--space-4); display: grid; }
.kpi b { font-size: var(--font-size-title-l); font-weight: 900; }
.kpi span { color: var(--color-ink-muted); font-size: var(--font-size-body-s); }
.link { color: var(--color-ink); font-weight: 700; }
.sub { font-size: var(--font-size-body-s); color: var(--color-ink-faint); margin: 0; }
.error { color: var(--color-coral-ink); }
.notice { color: var(--color-teal-ink); }
.modal-backdrop { position: fixed; inset: 0; z-index: 20; overflow: auto; background: rgb(12 15 20 / 40%); display: grid; place-items: center; padding: var(--space-4); }
.modal { background: var(--color-bg-soft); border-radius: var(--radius-xl); padding: var(--space-5); width: min(480px, 100%); box-sizing: border-box; display: grid; gap: var(--space-3); }
.modal-actions { display: flex; flex-wrap: wrap; justify-content: flex-end; gap: var(--space-2); }
</style>
