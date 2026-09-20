<script setup lang="ts">
import type { ContentBlock } from '../../../shared/schemas/content'

definePageMeta({ layout: 'learner' })
const { t } = useI18n()
const { api } = useApi()

interface N { id: string, title: string, body: ContentBlock[], isPinned: boolean, requiresAck: boolean, publishedAt: string | null, authorName: string | null, viewed: boolean, acked: boolean, lead: string | null }
const items = ref<N[]>([])
const open = ref<N | null>(null)
const error = ref('')

async function load() {
  try { items.value = await api<N[]>('/news') }
  catch (err) { error.value = apiErrorOf(err).message }
}
onMounted(load)

// Б.5: подтверждение засчитывается после 10 с на странице и прокрутки до кнопки — сервер проверяет
const seconds = ref(0)
const scrolled = ref(false)
const ackError = ref('')
let timer: ReturnType<typeof setInterval> | undefined
const bodyEl = ref<HTMLElement | null>(null)
async function show(n: N) {
  open.value = n; seconds.value = 0; scrolled.value = false; ackError.value = ''
  await api(`/news/${n.id}`)
  n.viewed = true
  clearInterval(timer)
  timer = setInterval(async () => { seconds.value++; if (seconds.value % 5 === 0) await api(`/news/${n.id}/view`, { method: 'POST', body: { seconds: 5, scrolledToEnd: scrolled.value } }).catch(() => null) }, 1000)
  await nextTick()
  checkScroll()
}
function checkScroll() {
  const el = bodyEl.value
  if (!el) return
  if (el.scrollHeight - el.scrollTop - el.clientHeight < 8) { if (!scrolled.value && open.value) { scrolled.value = true; api(`/news/${open.value.id}/view`, { method: 'POST', body: { seconds: 0, scrolledToEnd: true } }).catch(() => null) } }
}
function close() { clearInterval(timer); open.value = null }
onUnmounted(() => clearInterval(timer))
async function ack(n: N) {
  ackError.value = ''
  try {
    await api(`/news/${n.id}/view`, { method: 'POST', body: { seconds: seconds.value % 5, scrolledToEnd: scrolled.value } })
    await api(`/news/${n.id}/ack`, { method: 'POST' })
    n.acked = true
    close()
  }
  catch (err) { ackError.value = apiErrorOf(err).message }
}
const fmt = (d: string | null) => d ? new Date(d).toLocaleDateString('uk', { day: 'numeric', month: 'long' }) : ''
</script>

<template>
  <div>
    <h1>{{ t('news.title') }}</h1>
    <p v-if="error" class="error">{{ error }}</p>
    <p v-if="!error && items.length === 0" class="empty">{{ t('news.empty') }}</p>
    <div class="list">
      <button v-for="n in items" :key="n.id" :class="['card', { pinned: n.isPinned, unread: !n.viewed }]" @click="show(n)">
        <div class="row">
          <span v-if="n.isPinned" class="pin">📌</span>
          <span class="card-title">{{ n.title }}</span>
          <p v-if="n.lead" class="sub lead">{{ n.lead }}</p>
          <span v-if="n.requiresAck && !n.acked" class="badge coral">{{ t('news.needAck') }}</span>
          <span v-else-if="n.acked" class="badge teal">✓</span>
        </div>
        <span class="sub">{{ fmt(n.publishedAt) }} · {{ n.authorName }}</span>
      </button>
    </div>

    <div v-if="open" class="modal-backdrop" @click.self="!open.requiresAck || open.acked ? (open = null) : null">
      <div class="modal">
        <h2>{{ open.title }}</h2>
        <div ref="bodyEl" class="scroller" @scroll="checkScroll"><LessonBlocks :blocks="open.body" :blocks-state="{}" readonly /></div>
        <p v-if="ackError" class="error" role="alert">{{ ackError }}</p>
        <button v-if="open.requiresAck && !open.acked" class="primary" :disabled="seconds < 10 || !scrolled" @click="ack(open)">{{ t('news.ack') }}<span v-if="seconds < 10" class="sub"> · {{ 10 - seconds }}</span></button>
        <button v-else class="ghost" @click="close">{{ t('news.close') }}</button>
      </div>
    </div>
  </div>
</template>

<style scoped>
h1 { margin: 0 0 var(--space-4); font-weight: 900; }
.list { display: grid; gap: var(--space-2); }
.card { font: inherit; text-align: left; background: var(--color-bg-soft); border: none; border-radius: var(--radius-m); padding: var(--space-3) var(--space-4); cursor: pointer; display: grid; gap: var(--space-1); color: var(--color-ink); }
.card.unread { border-left: 4px solid var(--color-sun); }
.card.pinned { background: color-mix(in srgb, var(--color-sun) 15%, var(--color-bg-soft)); }
.row { display: flex; align-items: center; gap: var(--space-2); }
.card-title { flex: 1; font-weight: 800; }
.badge { font-size: var(--font-size-body-s); font-weight: 700; border-radius: var(--radius-pill); padding: 1px var(--space-2); }
.badge.coral { background: var(--color-coral); color: var(--color-coral-deep); }
.badge.teal { background: var(--color-teal); color: var(--color-teal-deep); }
.sub { font-size: var(--font-size-body-s); color: var(--color-ink-faint); }
.empty { color: var(--color-ink-faint); text-align: center; padding: var(--space-7); }
.error { color: var(--color-coral-ink); }
.modal-backdrop { position: fixed; inset: 0; background: rgb(12 15 20 / 50%); display: grid; place-items: center; padding: var(--space-4); z-index: 10; }
.modal { background: var(--color-bg-soft); border-radius: var(--radius-xl); padding: var(--space-5); width: min(560px, 100%); max-height: 90dvh; overflow: auto; display: grid; gap: var(--space-4); }
.modal h2 { margin: 0; font-weight: 900; }
.primary, .ghost { font: inherit; font-weight: 800; border: none; border-radius: var(--radius-pill); padding: var(--space-3) var(--space-5); cursor: pointer; }
.primary { background: var(--color-sun); color: var(--color-ink); }
.ghost { background: transparent; border: 1px solid var(--color-bg-line); color: var(--color-ink-muted); }
.scroller { max-height: 55dvh; overflow: auto; }
.error { color: var(--color-coral-ink); }
</style>
