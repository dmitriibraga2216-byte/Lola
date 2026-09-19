<script setup lang="ts">
/** Объявления с обязательным прочтением (docs/03 §3.22): модально при входе, пока не нажато «Ознайомився». */
const { t } = useI18n()
const { api } = useApi()
const { me } = useAuth()
interface A { id: string, title: string, body: unknown[], ackDueAt: string | null, publishedAt: string | null }
const items = ref<A[]>([])
const busy = ref(false)
async function load() {
  if (!me.value) return
  try { items.value = await api<A[]>('/news/pending-announcements') } catch { items.value = [] }
}
onMounted(load)
watch(() => me.value?.user.id as string | undefined, () => { load() })
async function ack(a: A) {
  busy.value = true
  try { await api<unknown>(`/news/${a.id}/ack`, { method: 'POST' }); items.value = items.value.filter(x => x.id !== a.id) }
  finally { busy.value = false }
}
</script>
<template>
  <div v-if="items.length" class="gate" data-testid="announcement-gate">
    <div class="modal">
      <span class="kicker">📣 {{ t('news.announcement') }}<template v-if="items.length > 1"> · {{ items.length }}</template></span>
      <h2>{{ items[0]!.title }}</h2>
      <p v-if="items[0]!.ackDueAt" class="sub">{{ t('news.ackUntil', { at: new Date(items[0]!.ackDueAt!).toLocaleDateString('uk-UA') }) }}</p>
      <div class="body"><LessonBlocks :blocks="items[0]!.body as never" :blocks-state="{}" readonly /></div>
      <button class="primary" :disabled="busy" data-testid="announcement-ack" @click="ack(items[0]!)">{{ t('news.iRead') }}</button>
    </div>
  </div>
</template>
<style scoped>
.gate { position: fixed; inset: 0; z-index: 90; background: rgb(12 15 20 / 55%); display: grid; place-items: center; padding: var(--space-4); overflow: auto; font-family: var(--font-family); color: var(--color-ink); }
.modal { background: var(--color-bg-soft); border-radius: var(--radius-xl); padding: var(--space-5); width: min(560px, 100%); box-sizing: border-box; display: grid; gap: var(--space-3); max-height: 90dvh; overflow: auto; }
.kicker { font-weight: 800; color: var(--color-coral-deep); font-size: var(--font-size-body-s); }
h2 { margin: 0; font-weight: 900; }
.sub { margin: 0; color: var(--color-ink-muted); font-size: var(--font-size-body-s); }
.body { max-height: 50dvh; overflow: auto; }
.primary { font: inherit; font-weight: 800; border: none; background: var(--color-sun); color: var(--color-ink); border-radius: var(--radius-pill); padding: var(--space-3) var(--space-4); cursor: pointer; justify-self: end; }
.primary:disabled { opacity: 0.5; }
</style>
