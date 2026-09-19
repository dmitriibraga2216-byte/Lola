<script setup lang="ts">
definePageMeta({ layout: 'learner' })
const { t } = useI18n()
const { api } = useApi()
const { hasScope } = useAuth()
const route = useRoute()
interface P { id: string, userId: string, fullName: string, status: string, waitlistPosition: number | null, checkInMethod: string | null, checkedInAt: string | null }
interface M { id: string, kind: string, title: string, description: unknown[], startsAt: string, endsAt: string, status: string, room: string | null, address: string | null, location: { name: string, address: string | null } | null, trainers: { id: string, fullName: string }[], capacity: number | null, registered: number, waitlist: number, seatsLeft: number | null, mine: { status: string, waitlistPosition: number | null } | null, enrollOpen: boolean, canCancel: boolean, materials: string[], materialsOpenAt: string, isTrainer: boolean, attendanceMode: string, webinar: { joinUrl: string | null, recordUrl: string | null } | null, participants?: P[] }
const m = ref<M | null>(null)
const error = ref('')
const notice = ref('')
const now = ref(Date.now())
let timer: ReturnType<typeof setInterval> | null = null
async function load() { try { m.value = await api<M>(`/meetups/${route.params.id}`) } catch (err) { error.value = apiErrorOf(err).message } }
onMounted(() => { load(); timer = setInterval(() => { now.value = Date.now() }, 1000) })
onUnmounted(() => { if (timer) clearInterval(timer) })
const countdown = computed(() => { if (!m.value) return ''; const left = new Date(m.value.startsAt).getTime() - now.value; if (left <= 0) return ''; const h = Math.floor(left / 3_600_000), mi = Math.floor((left % 3_600_000) / 60_000), s = Math.floor((left % 60_000) / 1000); return h > 48 ? t('mt.inDays', { n: Math.floor(h / 24) }) : `${h}:${String(mi).padStart(2, '0')}:${String(s).padStart(2, '0')}` })
async function act(fn: () => Promise<unknown>, ok?: string) { error.value = ''; notice.value = ''; try { const r = await fn() as { conflict?: string }; if (r?.conflict) notice.value = t('mt.conflict', { title: r.conflict }); else if (ok) notice.value = ok; await load() } catch (err) { error.value = apiErrorOf(err).message } }
const register = () => act(() => api(`/meetups/${route.params.id}/register`, { method: 'POST' }), t('mt.registeredOk'))
const unregister = () => act(() => api(`/meetups/${route.params.id}/register`, { method: 'DELETE' }), t('mt.unregisteredOk'))
const fmt = (d: string) => new Date(d).toLocaleString('uk-UA', { dateStyle: 'medium', timeStyle: 'short' })
const canManage = computed(() => m.value?.isTrainer || hasScope('meetup.attendance') || hasScope('meetup.manage'))
</script>
<template>
  <div>
    <NuxtLink to="/learn/meetups" class="back">← {{ t('mt.title') }}</NuxtLink>
    <p v-if="error" class="error">{{ error }}</p>
    <p v-if="notice" class="notice">{{ notice }}</p>
    <template v-if="m">
      <h1>{{ m.kind === 'webinar' ? '🎥 ' : '' }}{{ m.title }}</h1>
      <p class="sub">{{ fmt(m.startsAt) }} — {{ new Date(m.endsAt).toLocaleTimeString('uk-UA', { hour: '2-digit', minute: '2-digit' }) }} · {{ m.trainers.map(x => x.fullName).join(', ') }}</p>
      <p v-if="m.location || m.address" class="sub">📍 {{ m.location?.name }}{{ m.room ? `, ${m.room}` : '' }}{{ m.address ? ` · ${m.address}` : '' }}{{ m.location?.address ? ` · ${m.location.address}` : '' }}</p>
      <p v-if="countdown && m.status === 'planned'" class="count">{{ t('mt.startsIn') }} {{ countdown }}</p>
      <span v-if="m.status === 'cancelled'" class="badge coral">{{ t('mt.cancelled') }}</span>

      <section class="card">
        <div class="row">
          <span v-if="m.mine?.status === 'registered'" class="badge teal">{{ t('mt.registered') }}</span>
          <span v-else-if="m.mine?.status === 'attended'" class="badge teal">{{ t('mt.attended') }}</span>
          <span v-else-if="m.mine?.status === 'waitlist'" class="badge sun">{{ t('mt.inQueue', { n: m.mine.waitlistPosition }) }}</span>
          <span v-else-if="m.seatsLeft != null" class="sub">{{ m.seatsLeft > 0 ? t('mt.seatsLeft', { n: m.seatsLeft }) : t('mt.full') }}</span>
        </div>
        <div class="actions">
          <button v-if="!m.mine || ['cancelled', 'missed'].includes(m.mine.status)" class="primary" :disabled="!m.enrollOpen" data-testid="mt-register" @click="register">{{ m.enrollOpen ? (m.seatsLeft === 0 ? t('mt.joinQueue') : t('mt.register')) : t('mt.closed') }}</button>
          <button v-else-if="['registered', 'waitlist'].includes(m.mine.status)" class="chip" :disabled="!m.canCancel" data-testid="mt-unregister" @click="unregister">{{ m.canCancel ? t('mt.unregister') : t('mt.cannotCancel') }}</button>
          <a v-if="m.mine && ['registered', 'waitlist'].includes(m.mine.status)" :href="`/api/v1/meetups/${m.id}/ics`" class="chip">📅 {{ t('mt.addToCalendar') }}</a>
          <a v-if="m.webinar?.joinUrl" :href="m.webinar.joinUrl" target="_blank" class="primary" rel="noopener">{{ t('mt.join') }}</a>
          <a v-if="m.webinar?.recordUrl && m.status === 'finished'" :href="m.webinar.recordUrl" target="_blank" class="chip" rel="noopener">▶ {{ t('mt.record') }}</a>
          <NuxtLink v-if="m.attendanceMode !== 'manual' && m.mine?.status === 'registered'" to="/learn/meetups/checkin" class="chip">📷 {{ t('mt.scan') }}</NuxtLink>
          <NuxtLink v-if="canManage" :to="`/admin/meetups/${m.id}`" class="chip">⚙ {{ t('mt.manage') }}</NuxtLink>
        </div>
      </section>

      <section v-if="m.description?.length" class="card">
        <h2>{{ t('mt.program') }}</h2>
        <LessonBlocks :blocks="m.description as never" :blocks-state="{}" readonly />
      </section>
      <section class="card">
        <h2>{{ t('mt.materials') }}</h2>
        <p v-if="!m.materials.length" class="sub">{{ new Date(m.materialsOpenAt).getTime() > now ? t('mt.materialsAt', { at: fmt(m.materialsOpenAt) }) : t('mt.noMaterials') }}</p>
        <a v-for="id in m.materials" :key="id" :href="`/api/v1/media/${id}`" class="link" target="_blank">📎 {{ t('mt.material') }}</a>
      </section>
      <section v-if="m.participants" class="card">
        <h2>{{ t('mt.participants') }} ({{ m.registered }}<template v-if="m.capacity"> / {{ m.capacity }}</template>)</h2>
        <ul class="list"><li v-for="p in m.participants.filter(x => x.status !== 'cancelled')" :key="p.id">{{ p.fullName }} <span :class="['badge', p.status]">{{ t(`mt.status.${p.status}`) }}<template v-if="p.waitlistPosition"> {{ p.waitlistPosition }}</template></span></li></ul>
      </section>
    </template>
  </div>
</template>
<style scoped>
.back { color: var(--color-ink-muted); text-decoration: none; font-weight: 700; }
h1 { margin: var(--space-2) 0 0; font-weight: 900; }
h2 { margin: 0; font-weight: 800; font-size: var(--font-size-title-l); }
.sub { color: var(--color-ink-muted); font-size: var(--font-size-body-s); margin: var(--space-1) 0; }
.count { font-weight: 800; color: var(--color-teal-deep); margin: var(--space-2) 0; font-variant-numeric: tabular-nums; }
.card { background: var(--color-bg-soft); border-radius: var(--radius-l); padding: var(--space-3); display: grid; gap: var(--space-2); margin-top: var(--space-3); }
.row { display: flex; gap: var(--space-2); align-items: center; flex-wrap: wrap; }
.actions { display: flex; flex-wrap: wrap; gap: var(--space-2); }
.chip, .primary { font: inherit; font-weight: 700; border-radius: var(--radius-pill); padding: var(--space-2) var(--space-3); cursor: pointer; text-decoration: none; display: inline-block; }
.chip { border: 1px solid var(--color-bg-line); background: transparent; color: var(--color-ink); }
.primary { border: none; background: var(--color-sun); color: var(--color-ink); font-weight: 800; }
.primary:disabled, .chip:disabled { opacity: 0.5; }
.badge { font-size: var(--font-size-body-s); font-weight: 700; border-radius: var(--radius-pill); padding: 2px var(--space-2); background: var(--color-bg); color: var(--color-ink-muted); }
.badge.teal, .badge.registered, .badge.attended { background: var(--color-teal); color: var(--color-teal-deep); }
.badge.sun, .badge.waitlist { background: var(--color-sun); color: var(--color-sun-ink); }
.badge.coral, .badge.missed { background: var(--color-coral); color: var(--color-coral-deep); }
.list { list-style: none; margin: 0; padding: 0; display: grid; gap: var(--space-1); }
.link { color: var(--color-ink); font-weight: 700; }
.error { background: var(--color-coral); color: var(--color-coral-deep); padding: var(--space-3); border-radius: var(--radius-m); }
.notice { background: var(--color-teal); color: var(--color-teal-deep); padding: var(--space-3); border-radius: var(--radius-m); }
</style>
