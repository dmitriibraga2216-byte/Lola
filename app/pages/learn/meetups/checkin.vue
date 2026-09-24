<script setup lang="ts">
const { formatTime } = useFormat()
definePageMeta({ layout: 'learner' })
const { t } = useI18n()
const { api } = useApi()
const video = ref<HTMLVideoElement | null>(null)
const status = ref<'idle' | 'scanning' | 'done' | 'error' | 'nocamera'>('idle')
const message = ref('')
const manual = ref('')
const notRegistered = ref<{ kind: 'card' | 'session', id: string, seatsLeft: number | null } | null>(null)
let stream: MediaStream | null = null
let raf = 0

/**
 * docs/33 D-029: QR картки й сесії мають однаковий формат токена (id.вікно.hmac), але різні
 * таблиці — спершу пробуємо картку (kind=event, немігровані), і тільки як «чужий» токен —
 * сесію (meetup|webinar), куди тепер веде відмітка присутності.
 */
async function send(token: string) {
  status.value = 'idle'; notRegistered.value = null
  try {
    const r = await tryCheckin(token.trim())
    status.value = 'done'
    message.value = t('mt.checkedIn', { time: formatTime(new Date(r.checkedInAt), { hour: '2-digit', minute: '2-digit' }), title: r.title })
    stop()
  } catch (err) {
    const e = apiErrorOf(err)
    status.value = 'error'; message.value = e.message
    if (e.code === 'not_registered') notRegistered.value = { kind: e.details?.sessionId ? 'session' : 'card', id: String(e.details?.sessionId ?? e.details?.meetupId), seatsLeft: (e.details?.seatsLeft as number | null) ?? null }
  }
}
async function tryCheckin(token: string) {
  try { return await api<{ checkedInAt: string, title: string }>('/meetups/checkin', { method: 'POST', body: { token } }) }
  catch (err) {
    if (apiErrorOf(err).code !== 'bad_token') throw err
    return await api<{ checkedInAt: string, title: string }>('/meetup-sessions/checkin', { method: 'POST', body: { token } })
  }
}
async function registerNow() {
  if (!notRegistered.value) return
  const path = notRegistered.value.kind === 'session' ? `/meetup-sessions/${notRegistered.value.id}/register` : `/meetups/${notRegistered.value.id}/register`
  try { await api(path, { method: 'POST' }); message.value = t('mt.registeredOk'); notRegistered.value = null; start() } catch (err) { message.value = apiErrorOf(err).message }
}
async function start() {
  const w = window as unknown as { BarcodeDetector?: new (o: { formats: string[] }) => { detect: (v: HTMLVideoElement) => Promise<{ rawValue: string }[]> } }
  if (!w.BarcodeDetector || !navigator.mediaDevices?.getUserMedia) { status.value = 'nocamera'; return }
  try {
    stream = await navigator.mediaDevices.getUserMedia({ video: { facingMode: 'environment' } })
    video.value!.srcObject = stream
    await video.value!.play()
    status.value = 'scanning'
    const det = new w.BarcodeDetector({ formats: ['qr_code'] })
    const tick = async () => {
      if (status.value !== 'scanning') return
      try { const codes = await det.detect(video.value!); if (codes[0]?.rawValue) { await send(codes[0].rawValue); return } } catch { /* кадр не готов */ }
      raf = requestAnimationFrame(tick)
    }
    raf = requestAnimationFrame(tick)
  } catch { status.value = 'nocamera' }
}
function stop() { cancelAnimationFrame(raf); stream?.getTracks().forEach(tr => tr.stop()); stream = null }
onMounted(start)
onUnmounted(stop)
</script>
<template>
  <div>
    <NuxtLink to="/learn/meetups" class="back">← {{ t('mt.title') }}</NuxtLink>
    <h1>{{ t('mt.scanTitle') }}</h1>
    <video v-show="status === 'scanning'" ref="video" class="video" playsinline muted />
    <p v-if="status === 'scanning'" class="sub">{{ t('mt.pointCamera') }}</p>
    <p v-if="status === 'done'" class="ok">✓ {{ message }}</p>
    <p v-if="status === 'error'" class="error">{{ message }}</p>
    <button v-if="notRegistered && (notRegistered.seatsLeft == null || notRegistered.seatsLeft > 0)" class="primary" @click="registerNow">{{ t('mt.registerNow') }}</button>
    <section class="card">
      <p class="sub">{{ status === 'nocamera' ? t('mt.noCamera') : t('mt.orCode') }}</p>
      <div class="row"><input v-model="manual" class="field" :placeholder="t('mt.codePh')" data-testid="checkin-token"><button class="chip" :disabled="manual.length < 10" data-testid="checkin-send" @click="send(manual)">{{ t('mt.confirm') }}</button></div>
    </section>
  </div>
</template>
<style scoped>
.back { color: var(--color-ink-muted); text-decoration: none; font-weight: 700; }
h1 { margin: var(--space-2) 0; font-weight: 900; }
.video { width: 100%; border-radius: var(--radius-l); background: #000; aspect-ratio: 1; object-fit: cover; }
.sub { color: var(--color-ink-muted); font-size: var(--font-size-body-s); margin: var(--space-1) 0; }
.ok { background: var(--color-teal); color: var(--color-teal-deep); padding: var(--space-3); border-radius: var(--radius-m); font-weight: 800; }
.error { background: var(--color-coral); color: var(--color-coral-deep); padding: var(--space-3); border-radius: var(--radius-m); }
.card { background: var(--color-bg-soft); border-radius: var(--radius-l); padding: var(--space-3); display: grid; gap: var(--space-2); margin-top: var(--space-3); }
.row { display: flex; gap: var(--space-2); }
.field { font: inherit; padding: var(--space-2); border: 1px solid var(--color-bg-line); border-radius: var(--radius-m); background: var(--color-bg); flex: 1; min-width: 0; }
.chip, .primary { font: inherit; font-weight: 700; border-radius: var(--radius-pill); padding: var(--space-2) var(--space-3); cursor: pointer; }
.chip { border: 1px solid var(--color-bg-line); background: transparent; color: var(--color-ink); }
.primary { border: none; background: var(--color-sun); color: var(--color-ink); font-weight: 800; margin-top: var(--space-2); }
.chip:disabled { opacity: 0.5; }
</style>
