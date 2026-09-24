<script setup lang="ts">
/** Оголошення з підписом (мокап Notice): бейдж типу, назва, «Опубліковано · діє до», текст, файли, липкая кнопка «Ознайомився». */
const { formatDate, formatDateTime } = useFormat()
definePageMeta({ layout: 'learner' })
const { t } = useI18n()
const { api } = useApi()
const route = useRoute()
interface N { id: string, title: string, body: unknown[], kind: string, priority: string, publishedAt: string | null, endsAt: string | null, dueAt: string | null, ackedAt: string | null, ackText: string | null, attachments: { mediaId: string, name: string, bytes?: number }[] }
const n = ref<N | null>(null)
const error = ref('')
const busy = ref(false)
const d = (s: string | null) => s ? formatDate(new Date(s), { day: 'numeric', month: 'long' }) : ''
onMounted(async () => { try { n.value = await api<N>(`/notices/${route.params.id}`) } catch (err) { error.value = apiErrorOf(err).message } })
async function ack() {
  if (!n.value) return
  busy.value = true; error.value = ''
  try { const r = await api<{ ackedAt: string }>(`/notices/${n.value.id}/acknowledge`, { method: 'POST' }); n.value.ackedAt = r.ackedAt } catch (err) { error.value = apiErrorOf(err).message } finally { busy.value = false }
}
</script>
<template>
  <div class="page">
    <NuxtLink to="/learn/notices" class="link back">← {{ t('notices.title') }}</NuxtLink>
    <p v-if="error" class="error-text" role="alert">{{ error }}</p>
    <template v-if="n">
      <!-- Мокап Notice: бейдж «Ознайомлення» — бірюзовий (color-teal), не сонячний; для інших типів мокапу немає, лишаємо сонячний -->
      <span :class="['badge', n.kind === 'acknowledge' ? 'teal' : 'sun']">{{ t(`notices.kind.${n.kind}`) }}</span>
      <h1>{{ n.title }}</h1>
      <p class="muted meta"><template v-if="n.publishedAt">{{ t('notices.publishedOn', { d: d(n.publishedAt) }) }}</template><template v-if="n.endsAt"> · {{ t('notices.activeUntil', { d: d(n.endsAt) }) }}</template><template v-if="n.dueAt && !n.ackedAt"> · {{ t('notices.ackUntil', { d: d(n.dueAt) }) }}</template></p>
      <div class="body"><LessonBlocks :blocks="n.body as never" :blocks-state="{}" readonly /></div>
      <ul v-if="n.attachments?.length" class="files">
        <li v-for="f in n.attachments" :key="f.mediaId" class="card tight">📎 {{ f.name }}<span v-if="f.bytes" class="muted"> · {{ Math.round(f.bytes / 1024) }} {{ t('notices.kb') }}</span></li>
      </ul>
      <div class="sticky-bottom">
        <p v-if="n.ackedAt" class="note teal">{{ t('notices.ackedOn', { d: formatDateTime(new Date(n.ackedAt)) }) }}</p>
        <template v-else>
          <p class="help">{{ t('notices.ackHint') }}</p>
          <button class="btn primary" :disabled="busy" data-testid="notice-ack" @click="ack">{{ n.ackText || t('news.iRead') }}</button>
        </template>
      </div>
    </template>
  </div>
</template>
<style scoped>
.page { display: grid; gap: var(--space-2); }
.back { font-size: var(--font-size-body-s); }
.badge { justify-self: start; }
h1 { margin: 0; font-weight: 900; }
.meta { margin: 0; font-size: var(--font-size-body-s); }
.files { list-style: none; margin: 0; padding: 0; display: grid; gap: var(--space-1); }
.sticky-bottom { margin-top: var(--space-3); display: grid; gap: var(--space-2); }
.help { margin: 0; }
</style>
