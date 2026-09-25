<script setup lang="ts">
/**
 * Вкладка «Підсумок» картки кандидата (docs/v2/30-ai-interview.md §5.4, §7.14, §7.15; `28` §5.3).
 *
 * Шапка — «Підсумок кандидата», бейдж «Неповне проходження», версія й дата; розділи §7.14, кожен
 * можна вимкнути перед надсиланням; дії «Сформувати заново», «Редагувати», «Надіслати кандидату»,
 * «Скопіювати посилання», «Відкликати доступ». Заплановане автоматичне надсилання видно тут же з
 * датою і кнопкою «Скасувати» (§8 «Можна скасувати»). Внизу — незнімний рядок «Документ
 * сформовано автоматично…» з тексту самого документа: ні розділи, ні правка його не прибирають.
 */
const props = defineProps<{ candidateId: string }>()

const { t } = useI18n()
const { api } = useApi()
const { hasScope } = useAuth()
const { formatDate, formatDateTime } = useFormat()

const SECTIONS = ['candidate', 'progress', 'scores', 'interview', 'strengths_risks', 'incomplete', 'passport'] as const

interface Summary {
  id: string
  version: number
  state: 'draft' | 'ready' | 'sent' | 'revoked' | 'expired'
  completeness: 'full' | 'partial'
  sections: string[]
  body: Record<string, unknown> & { strengthsRisks?: { strengths: string[], risks: string[] } } | null
  disclaimerLine: string | null
  isLatest: boolean
  sentAt: string | null
  shareUrl: string | null
  shareExpiresAt: string | null
  revokedAt: string | null
  redactedAt: string | null
  autoSend: { dueAt: string | null, cancelledAt: string | null }
  createdAt: string
}

const items = ref<Summary[]>([])
const error = ref('')
const notice = ref('')
const busy = ref(false)
const sections = ref<string[]>([])
const editing = ref(false)
const strengths = ref('')
const risks = ref('')
const revoking = ref(false)
const revokeReason = ref('')

const latest = computed(() => items.value.find(s => s.isLatest) ?? null)
const older = computed(() => items.value.filter(s => !s.isLatest))
const off = computed(() => SECTIONS.filter(s => !sections.value.includes(s)))
const canEdit = computed(() => hasScope('summary.edit') && latest.value?.state === 'ready' && !latest.value.redactedAt)
const canSend = computed(() => hasScope('summary.send') && !!latest.value && ['ready', 'sent'].includes(latest.value.state) && !latest.value.redactedAt)

async function load() {
  error.value = ''
  try {
    const r = await api<{ items: Summary[] }>('/candidate-summaries', { query: { candidateId: props.candidateId, limit: 20 } })
    items.value = r.items
    sections.value = [...(latest.value?.sections ?? [])]
  }
  catch (err) { error.value = apiErrorOf(err).message }
}
onMounted(load)

async function run(fn: () => Promise<unknown>, done?: string) {
  busy.value = true
  error.value = ''
  notice.value = ''
  try {
    await fn()
    if (done) notice.value = done
    await load()
  }
  catch (err) { error.value = apiErrorOf(err).message }
  finally { busy.value = false }
}

function build() {
  if (latest.value?.state === 'sent' && !window.confirm(t('candidateSummary.rebuildConfirm'))) return
  return run(() => api('/candidate-summaries', { method: 'POST', body: { candidateId: props.candidateId } }))
}

const saveSections = () => run(() => api(`/candidate-summaries/${latest.value!.id}`, { method: 'PATCH', body: { sections: sections.value } }), t('candidateSummary.saved'))

function startEdit() {
  strengths.value = (latest.value?.body?.strengthsRisks?.strengths ?? []).join('\n')
  risks.value = (latest.value?.body?.strengthsRisks?.risks ?? []).join('\n')
  editing.value = true
}

const lines = (text: string) => text.split('\n').map(s => s.trim()).filter(Boolean)
async function saveEdit() {
  await run(() => api(`/candidate-summaries/${latest.value!.id}`, { method: 'PATCH', body: { strengths: lines(strengths.value), risks: lines(risks.value) } }), t('candidateSummary.saved'))
  if (!error.value) editing.value = false
}

const send = () => run(() => api(`/candidate-summaries/${latest.value!.id}/send`, { method: 'POST', body: { channel: 'email' } }))

async function copyLink() {
  await run(async () => {
    const url = latest.value?.state === 'sent' && latest.value.shareUrl
      ? latest.value.shareUrl
      : (await api<{ shareUrl: string }>(`/candidate-summaries/${latest.value!.id}/send`, { method: 'POST', body: { channel: 'link' } })).shareUrl
    await navigator.clipboard.writeText(url)
  }, t('candidateSummary.copied'))
}

async function revoke() {
  await run(() => api(`/candidate-summaries/${latest.value!.id}/revoke`, { method: 'POST', body: { reason: revokeReason.value } }), t('candidateSummary.revoked'))
  if (!error.value) {
    revoking.value = false
    revokeReason.value = ''
  }
}

const cancelAuto = () => run(() => api(`/candidate-summaries/${latest.value!.id}/auto-send/cancel`, { method: 'POST' }), t('candidateSummary.autoCancelled'))
</script>

<template>
  <div class="stack">
    <p v-if="error" class="note coral" role="alert">{{ error }}</p>
    <p v-if="notice" class="note teal" role="status">{{ notice }}</p>

    <div v-if="!latest" class="row between">
      <p class="muted">{{ t('candidateSummary.empty') }}</p>
      <button v-if="hasScope('summary.edit')" class="btn primary small" type="button" :disabled="busy" @click="build">{{ t('candidateSummary.build') }}</button>
    </div>

    <article v-else class="card stack">
      <header class="row between">
        <div>
          <h3 class="h3">{{ t('candidateSummary.title') }}</h3>
          <p class="sub">{{ t('candidateSummary.version', { n: latest.version }) }} · {{ formatDateTime(latest.createdAt) }} · {{ t(`candidateSummary.state.${latest.state}`) }}</p>
        </div>
        <span v-if="latest.completeness === 'partial'" class="badge sun">{{ t('candidateSummary.partial') }}</span>
      </header>

      <p v-if="latest.redactedAt" class="note sun">{{ t('candidateSummary.redacted', { date: formatDate(latest.redactedAt) }) }}</p>
      <p v-if="latest.state === 'sent' && latest.sentAt" class="note teal">{{ t('candidateSummary.sent', { date: formatDate(latest.sentAt), until: latest.shareExpiresAt ? formatDate(latest.shareExpiresAt) : '—' }) }}</p>
      <div v-if="latest.autoSend.dueAt" class="note sun row between">
        <span>{{ t('candidateSummary.autoDue', { date: formatDateTime(latest.autoSend.dueAt) }) }}</span>
        <button v-if="hasScope('summary.send')" class="btn ghost small" type="button" :disabled="busy" @click="cancelAuto">{{ t('candidateSummary.autoCancel') }}</button>
      </div>

      <fieldset v-if="canEdit" class="sections">
        <legend class="h4">{{ t('candidateSummary.sectionsTitle') }}</legend>
        <label v-for="s in SECTIONS" :key="s" class="row">
          <input v-model="sections" type="checkbox" :value="s">
          <span>{{ t(`candidateSummary.section.${s}`) }}</span>
        </label>
        <p class="sub">{{ t('candidateSummary.sectionsHint') }}</p>
        <button class="btn ghost small" type="button" :disabled="busy" @click="saveSections">{{ t('candidateSummary.save') }}</button>
      </fieldset>

      <form v-if="editing" class="stack" @submit.prevent="saveEdit">
        <label>{{ t('candidateSummary.strengths') }}
          <textarea v-model="strengths" class="field" rows="4" :aria-describedby="'sum-edit-hint'" />
        </label>
        <label>{{ t('candidateSummary.risks') }}
          <textarea v-model="risks" class="field" rows="4" :aria-describedby="'sum-edit-hint'" />
        </label>
        <p id="sum-edit-hint" class="sub">{{ t('candidateSummary.editHint') }}</p>
        <div class="row">
          <button class="btn primary small" type="submit" :disabled="busy">{{ t('candidateSummary.save') }}</button>
          <button class="btn ghost small" type="button" @click="editing = false">{{ t('common.cancel') }}</button>
        </div>
      </form>

      <SummaryDocument v-if="latest.body" :doc="latest.body" :disclaimer-line="latest.disclaimerLine" :off="off" />

      <div class="row actions">
        <button v-if="hasScope('summary.edit')" class="btn ghost small" type="button" :disabled="busy" @click="build">{{ t('candidateSummary.rebuild') }}</button>
        <button v-if="canEdit && !editing" class="btn ghost small" type="button" @click="startEdit">{{ t('candidateSummary.edit') }}</button>
        <button v-if="canSend && latest.state === 'ready'" class="btn primary small" type="button" :disabled="busy" @click="send">{{ t('candidateSummary.send') }}</button>
        <button v-if="canSend" class="btn ghost small" type="button" :disabled="busy" @click="copyLink">{{ t('candidateSummary.copy') }}</button>
        <button v-if="canSend && !revoking" class="btn ghost small" type="button" @click="revoking = true">{{ t('candidateSummary.revoke') }}</button>
      </div>
      <form v-if="revoking" class="row" @submit.prevent="revoke">
        <label class="grow">{{ t('candidateSummary.revokeReason') }}
          <input v-model="revokeReason" class="field" minlength="3" maxlength="500" required>
        </label>
        <button class="btn primary small" type="submit" :disabled="busy">{{ t('candidateSummary.revoke') }}</button>
        <button class="btn ghost small" type="button" @click="revoking = false">{{ t('common.cancel') }}</button>
      </form>

      <details v-if="older.length">
        <summary>{{ t('candidateSummary.versions') }}</summary>
        <ul class="older">
          <li v-for="s in older" :key="s.id">{{ t('candidateSummary.version', { n: s.version }) }} · {{ formatDate(s.createdAt) }} · {{ t(`candidateSummary.state.${s.state}`) }}</li>
        </ul>
      </details>
    </article>
  </div>
</template>

<style scoped>
.stack { display: grid; gap: var(--space-3); }
.row { display: flex; gap: var(--space-2); align-items: center; flex-wrap: wrap; }
.between { justify-content: space-between; }
.grow { flex: 1; min-width: 12rem; display: grid; gap: var(--space-1); }
.h3 { margin: 0; font-size: var(--font-size-body); font-weight: 900; }
.h4 { font-size: var(--font-size-body-s); font-weight: 900; text-transform: uppercase; letter-spacing: 0.04em; color: var(--color-ink-muted); }
.sub { margin: 0; color: var(--color-ink-muted); font-size: var(--font-size-body-s); }
.sections { display: grid; gap: var(--space-1); border: 1px solid var(--color-bg-line-soft); border-radius: var(--radius-s); padding: var(--space-3); margin: 0; }
.actions { border-top: 1px solid var(--color-bg-line-soft); padding-top: var(--space-2); }
label { display: grid; gap: var(--space-1); }
label.row { display: flex; }
.older { margin: var(--space-2) 0 0; padding-left: var(--space-4); color: var(--color-ink-muted); font-size: var(--font-size-body-s); }
</style>
