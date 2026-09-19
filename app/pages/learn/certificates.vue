<script setup lang="ts">
definePageMeta({ layout: 'learner' })

const { t } = useI18n()
const { api } = useApi()

interface Cert {
  id: string
  number: string
  score: string | null
  issuedAt: string
  validUntil: string | null
  revokedAt: string | null
  publicToken: string
  courseTitle: string | null
}

const items = ref<Cert[]>([])
const error = ref('')
const copied = ref('')

onMounted(async () => {
  try {
    items.value = await api<Cert[]>('/learning/certificates')
  }
  catch (err) {
    error.value = apiErrorOf(err).message
  }
})

function status(c: Cert): { text: string, tone: string } {
  if (c.revokedAt) return { text: t('cert.revoked'), tone: 'coral' }
  if (c.validUntil && new Date(c.validUntil) < new Date()) return { text: t('cert.expired'), tone: 'muted' }
  return { text: t('cert.valid'), tone: 'teal' }
}

const fmt = (d: string | null) => d ? new Date(d).toLocaleDateString('uk', { day: 'numeric', month: 'long', year: 'numeric' }) : '—'

async function share(c: Cert) {
  const url = `${location.origin}/c/${c.publicToken}`
  try {
    if (navigator.share) await navigator.share({ title: c.number, url })
    else {
      await navigator.clipboard.writeText(url)
      copied.value = c.id
      setTimeout(() => { copied.value = '' }, 2000)
    }
  }
  catch { /* отмена шеринга — не ошибка */ }
}
</script>

<template>
  <div>
    <h1>{{ t('learner.certificates') }}</h1>
    <p v-if="error" class="error">{{ error }}</p>
    <p v-if="!error && items.length === 0" class="empty">{{ t('cert.empty') }}</p>

    <div class="grid">
      <div v-for="c in items" :key="c.id" :class="['card', { dim: status(c).tone !== 'teal' }]">
        <div class="num">{{ c.number }}</div>
        <div class="title">{{ c.courseTitle }}</div>
        <span :class="['badge', status(c).tone]">{{ status(c).text }}</span>
        <dl>
          <dt>{{ t('cert.issued') }}</dt><dd>{{ fmt(c.issuedAt) }}</dd>
          <dt>{{ t('cert.validUntil') }}</dt><dd>{{ fmt(c.validUntil) }}</dd>
          <template v-if="c.score"><dt>{{ t('cert.score') }}</dt><dd>{{ Number(c.score) }}%</dd></template>
        </dl>
        <div class="actions">
          <a v-if="!c.revokedAt" :href="`/api/v1/certificates/${c.id}/pdf`" target="_blank" rel="noopener" class="btn ghost" data-testid="cert-pdf">{{ t('cert.downloadPdf') }}</a>
          <a :href="`/c/${c.publicToken}`" target="_blank" rel="noopener" class="btn ghost">{{ t('cert.open') }}</a>
          <button class="btn primary" @click="share(c)">{{ copied === c.id ? t('cert.copied') : t('cert.share') }}</button>
        </div>
      </div>
    </div>
  </div>
</template>

<style scoped>
h1 { margin: 0 0 var(--space-4); font-weight: 900; }
.grid { display: grid; gap: var(--space-3); grid-template-columns: repeat(auto-fill, minmax(260px, 1fr)); }
.card { background: var(--color-bg-soft); border: 1px solid var(--color-bg-line); border-radius: var(--radius-l); padding: var(--space-4); display: grid; gap: var(--space-2); }
.card.dim { opacity: 0.7; }
.num { font-size: var(--font-size-body-s); color: var(--color-ink-faint); font-family: monospace; }
.title { font-weight: 800; font-size: var(--font-size-title-l); }
.badge { justify-self: start; font-size: var(--font-size-body-s); font-weight: 700; border-radius: var(--radius-pill); padding: 2px var(--space-3); }
.badge.teal { background: var(--color-teal); color: var(--color-teal-deep); }
.badge.coral { background: var(--color-coral); color: var(--color-coral-deep); }
.badge.muted { background: var(--color-bg-line-soft); color: var(--color-ink-muted); }
dl { display: grid; grid-template-columns: auto 1fr; gap: var(--space-1) var(--space-3); margin: 0; font-size: var(--font-size-body-s); }
dt { color: var(--color-ink-faint); }
dd { margin: 0; }
.actions { display: flex; gap: var(--space-2); margin-top: var(--space-2); }
.btn { font: inherit; font-weight: 800; border: none; border-radius: var(--radius-pill); padding: var(--space-2) var(--space-4); cursor: pointer; text-decoration: none; text-align: center; flex: 1; }
.primary { background: var(--color-sun); color: var(--color-ink); }
.ghost { background: transparent; border: 1px solid var(--color-bg-line); color: var(--color-ink-muted); }
.empty { color: var(--color-ink-faint); text-align: center; padding: var(--space-7); }
.error { color: var(--color-coral-ink); }
</style>
