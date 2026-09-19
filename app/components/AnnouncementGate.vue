<script setup lang="ts">
/**
 * Объявления (docs/21 §5.4, §7.4): модально при входе, баннер сверху или оба; цвет по приоритету;
 * `block_until_ack` — закрыть крестиком нельзя, интерфейс перекрыт до подтверждения (кроме входа и профиля).
 * Подтверждение — только после 10 с и прокрутки (Б.5).
 */
const { t } = useI18n()
const { api } = useApi()
const { me } = useAuth()
const route = useRoute()
interface A { id: string, title: string, body: unknown[], ackDueAt: string | null, publishedAt: string | null, showMode: 'modal' | 'banner' | 'both', priority: 'normal' | 'important' | 'critical', blockUntilAck: boolean, ackText: string | null, requiresAck: boolean }
const items = ref<A[]>([])
const busy = ref(false)
const error = ref('')
const dismissed = ref<Set<string>>(new Set())
const seconds = ref(0)
const scrolled = ref(false)
const bodyEl = ref<HTMLElement | null>(null)
let timer: ReturnType<typeof setInterval> | undefined

async function load() {
  if (!me.value) return
  try { items.value = await api<A[]>('/news/pending-announcements') } catch { items.value = [] }
}
onMounted(load)
watch(() => me.value?.user.id as string | undefined, () => { load() })

const modal = computed(() => items.value.find(a => (a.showMode === 'modal' || a.showMode === 'both') && !dismissed.value.has(a.id)) ?? null)
const banners = computed(() => items.value.filter(a => (a.showMode === 'banner' || a.showMode === 'both') && a.id !== modal.value?.id))
const blocked = computed(() => !!modal.value?.blockUntilAck && !route.path.startsWith('/profile'))

watch(modal, (m) => {
  clearInterval(timer); seconds.value = 0; scrolled.value = false; error.value = ''
  if (!m) return
  timer = setInterval(async () => { seconds.value++; if (seconds.value % 5 === 0) await api(`/news/${m.id}/view`, { method: 'POST', body: { seconds: 5, scrolledToEnd: scrolled.value } }).catch(() => null) }, 1000)
  nextTick(checkScroll)
}, { immediate: true })
onUnmounted(() => clearInterval(timer))
function checkScroll() {
  const el = bodyEl.value
  if (!el || !modal.value) return
  if (el.scrollHeight - el.scrollTop - el.clientHeight < 8 && !scrolled.value) { scrolled.value = true; api(`/news/${modal.value.id}/view`, { method: 'POST', body: { seconds: 0, scrolledToEnd: true } }).catch(() => null) }
}
async function ack(a: A) {
  busy.value = true; error.value = ''
  try {
    await api(`/news/${a.id}/view`, { method: 'POST', body: { seconds: seconds.value % 5, scrolledToEnd: scrolled.value } })
    await api<unknown>(`/news/${a.id}/ack`, { method: 'POST' })
    items.value = items.value.filter(x => x.id !== a.id)
  }
  catch (err) { error.value = apiErrorOf(err).message }
  finally { busy.value = false }
}
function dismiss(a: A) { if (a.blockUntilAck) return; dismissed.value = new Set([...dismissed.value, a.id]) }
</script>
<template>
  <div>
    <div v-for="b in banners" :key="b.id" :class="['banner', b.priority]" role="status" data-testid="announcement-banner">
      <span class="btitle">📣 {{ b.title }}</span>
      <button class="blink" @click="dismissed = new Set([...dismissed].filter(x => x !== b.id)); items = items.map(x => x.id === b.id ? { ...x, showMode: 'modal' } : x)">{{ t('news.open') }}</button>
    </div>
    <div v-if="modal" :class="['gate', { blocked }]" data-testid="announcement-gate">
      <div :class="['modal', modal.priority]" role="dialog" aria-modal="true">
        <div class="top">
          <span class="kicker">📣 {{ t('news.announcement') }}<template v-if="items.length > 1"> · {{ items.length }}</template><span v-if="modal.priority !== 'normal'" class="prio"> · {{ t(`news.prio.${modal.priority}`) }}</span></span>
          <button v-if="!modal.blockUntilAck" class="x" :aria-label="t('news.close')" @click="dismiss(modal)">×</button>
        </div>
        <h2>{{ modal.title }}</h2>
        <p v-if="modal.ackDueAt" class="sub">{{ t('news.ackUntil', { at: new Date(modal.ackDueAt).toLocaleDateString('uk-UA') }) }}</p>
        <p v-if="modal.blockUntilAck" class="sub">{{ t('news.blockHint') }}</p>
        <div ref="bodyEl" class="body" @scroll="checkScroll"><LessonBlocks :blocks="modal.body as never" :blocks-state="{}" readonly /></div>
        <p v-if="error" class="error" role="alert">{{ error }}</p>
        <button class="primary" :disabled="busy || seconds < 10 || !scrolled" data-testid="announcement-ack" @click="ack(modal)">{{ modal.ackText || t('news.iRead') }}<span v-if="seconds < 10 || !scrolled" class="hint"> · {{ seconds < 10 ? 10 - seconds : '↓' }}</span></button>
      </div>
    </div>
  </div>
</template>
<style scoped>
.banner { display: flex; align-items: center; gap: var(--space-3); padding: var(--space-2) var(--space-4); font-weight: 700; font-family: var(--font-family); }
.banner.normal, .banner.important { background: var(--color-sun); color: var(--color-sun-ink); }
.banner.critical { background: var(--color-coral); color: var(--color-coral-deep); }
.btitle { flex: 1; min-width: 0; overflow: hidden; text-overflow: ellipsis; white-space: nowrap; }
.blink { font: inherit; font-weight: 800; border: 1px solid currentcolor; background: transparent; color: inherit; border-radius: var(--radius-pill); padding: 2px var(--space-3); cursor: pointer; }
.gate { position: fixed; inset: 0; z-index: 90; background: rgb(12 15 20 / 55%); display: grid; place-items: center; padding: var(--space-4); overflow: auto; font-family: var(--font-family); color: var(--color-ink); }
.gate.blocked { background: rgb(12 15 20 / 85%); }
.modal { background: var(--color-bg-soft); border-radius: var(--radius-xl); padding: var(--space-5); width: min(560px, 100%); box-sizing: border-box; display: grid; gap: var(--space-3); max-height: 90dvh; overflow: hidden; border-top: 6px solid var(--color-sun); }
.modal.critical { border-top-color: var(--color-coral); }
.top { display: flex; justify-content: space-between; align-items: center; }
.kicker { font-weight: 800; color: var(--color-coral-deep); font-size: var(--font-size-body-s); }
.prio { color: var(--color-ink-muted); }
.x { font: inherit; font-size: var(--font-size-title-l); border: none; background: transparent; cursor: pointer; color: var(--color-ink-muted); line-height: 1; }
h2 { margin: 0; font-weight: 900; }
.sub { margin: 0; color: var(--color-ink-muted); font-size: var(--font-size-body-s); }
.body { max-height: 50dvh; overflow: auto; }
.primary { font: inherit; font-weight: 800; border: none; background: var(--color-sun); color: var(--color-ink); border-radius: var(--radius-pill); padding: var(--space-3) var(--space-4); cursor: pointer; justify-self: end; }
.primary:disabled { opacity: 0.6; }
.hint { font-weight: 400; }
.error { color: var(--color-coral-ink); margin: 0; }
</style>
