<script setup lang="ts">
/**
 * «Політики зберігання» (docs/v2/34-storage.md §5.2, §6.2, §7.3): строка на происхождение,
 * пустого состояния нет — список фиксирован. У нового тенанта выключено всё; первое включение
 * удаляющей политики — только после сухого прогона и подтверждения объёма (сервер повторяет
 * это правило, `422 dry_run_required`). Срок корзины (`trashDays`) — здесь же: решение
 * `44` §8 держит его строкой политики, а не константой в коде.
 */
import { STORAGE_RETENTION_ACTIONS, STORAGE_RETENTION_ANCHORS } from '#shared/enums'

definePageMeta({ layout: 'admin', middleware: 'admin-scope', requiredScope: 'storage.policy' })

const { t } = useI18n()
const { api } = useApi()
const { formatBytes } = useFormat()

interface Policy {
  origin: string, enabled: boolean, keepMonths: number | null, anchor: string, action: string, keepEvidence: boolean
  warnDaysBefore: number, maxBatchPerRun: number, trashDays: number, acknowledgeEvidence?: boolean
}
interface DryRun { files: number, bytes: number, evidenceCount: number }

const policies = ref<Policy[]>([])
const original = ref<Record<string, Policy>>({})
const loading = ref(true)
const loadError = ref('')
const error = ref('')
const notice = ref('')
const busy = ref(false)
const dryRuns = ref<Record<string, DryRun>>({})
const dryRunFailed = ref(false)
const confirmVolume = ref(false)

async function load() {
  loading.value = true
  loadError.value = ''
  try {
    const rows = await api<Policy[]>('/storage/retention-policies')
    policies.value = rows.map(p => ({ ...p, acknowledgeEvidence: false }))
    original.value = Object.fromEntries(rows.map(p => [p.origin, { ...p }]))
  }
  catch (err) { loadError.value = apiErrorOf(err).message }
  finally { loading.value = false }
}
onMounted(load)

const deleting = (p: Policy) => p.enabled && p.action !== 'notify_only'
const keepInvalid = (p: Policy) => deleting(p) && (typeof p.keepMonths !== 'number' || p.keepMonths < 1 || p.keepMonths > 120)
/** Удаляющие политики, которые включаются впервые, — им нужен сухой прогон (§7.3). */
const firstOn = computed(() => policies.value.filter(p => deleting(p) && !deleting(original.value[p.origin] ?? p)))
const needsAck = computed(() => policies.value.filter(p => deleting(p) && !p.keepEvidence && !p.acknowledgeEvidence))
const dryRunDone = computed(() => firstOn.value.every(p => dryRuns.value[p.origin]))
const canSave = computed(() => !busy.value && !dryRunFailed.value && !policies.value.some(keepInvalid) && !needsAck.value.length
  && (!firstOn.value.length || (dryRunDone.value && confirmVolume.value)))

async function dryRun() {
  busy.value = true
  error.value = ''
  dryRunFailed.value = false
  try {
    for (const p of policies.value.filter(deleting)) {
      dryRuns.value[p.origin] = await api<DryRun>('/storage/retention-policies/dry-run', {
        method: 'POST',
        body: { origin: p.origin, keepMonths: p.keepMonths, anchor: p.anchor, action: p.action, keepEvidence: p.keepEvidence },
      })
    }
  }
  catch { dryRunFailed.value = true }
  finally { busy.value = false }
}

/** Пустое числовое поле (`v-model.number` даёт '') — «срока нет», а не 0; обязательные поля — прежнее значение. */
const num = (v: unknown): number | null => (typeof v === 'number' && Number.isFinite(v) ? v : null)
function normalized(): Policy[] {
  return policies.value.map((p) => {
    const was = original.value[p.origin]
    return { ...p, keepMonths: num(p.keepMonths), warnDaysBefore: num(p.warnDaysBefore) ?? was?.warnDaysBefore ?? 14, trashDays: num(p.trashDays) ?? was?.trashDays ?? 30 }
  })
}

async function save() {
  if (!canSave.value) return
  busy.value = true
  error.value = ''
  notice.value = ''
  try {
    const rows = await api<Policy[]>('/storage/retention-policies', {
      method: 'PUT',
      body: { policies: normalized(), dryRunConfirmed: dryRunDone.value && confirmVolume.value },
    })
    policies.value = rows.map(p => ({ ...p, acknowledgeEvidence: false }))
    original.value = Object.fromEntries(rows.map(p => [p.origin, { ...p }]))
    confirmVolume.value = false
    notice.value = t('storage.policies.saved')
  }
  catch (err) {
    const e = apiErrorOf(err)
    error.value = e.code === 'dry_run_required' ? t('storage.policies.dryRunRequired') : e.code === 'evidence_ack_required' ? t('storage.policies.evidenceAckRequired') : e.message
  }
  finally { busy.value = false }
}

// Правка политики сбрасывает её прогон: объём считался для других условий
function touched(p: Policy) {
  dryRuns.value = Object.fromEntries(Object.entries(dryRuns.value).filter(([origin]) => origin !== p.origin))
  dryRunFailed.value = false
  confirmVolume.value = false
}
</script>

<template>
  <div>
    <PageHeader :title="t('storage.tabs.policies')" :crumbs="[{ label: t('admin.section.settings') }, { label: t('storage.title'), to: '/admin/settings/storage' }, { label: t('storage.tabs.policies') }]" />
    <StorageTabs />

    <p class="help intro">{{ t('storage.policies.intro') }}</p>
    <p class="note sun">{{ t('storage.policies.notScheduled') }}</p>

    <p v-if="loading" class="help">{{ t('common.loading') }}</p>
    <p v-else-if="loadError" class="error-text" role="alert">{{ loadError }}</p>
    <form v-else class="policies" @submit.prevent="save">
      <fieldset v-for="p in policies" :key="p.origin" class="card policy" :class="{ on: p.enabled }">
        <legend class="sr-only">{{ t(`storage.origin.${p.origin}`) }}</legend>
        <div class="policy-head">
          <b class="policy-name">{{ t(`storage.origin.${p.origin}`) }}</b>
          <label class="toggle">
            <input v-model="p.enabled" type="checkbox" @change="touched(p)">
            <span>{{ t('storage.policies.enabled') }}</span>
          </label>
        </div>
        <div class="grid">
          <label class="cell">
            <span>{{ t('storage.policies.keep') }}</span>
            <input
              v-model.number="p.keepMonths"
              type="number"
              min="1"
              max="120"
              class="field"
              :aria-invalid="keepInvalid(p)"
              :aria-describedby="keepInvalid(p) ? `keep-err-${p.origin}` : undefined"
              @input="touched(p)"
            >
            <small v-if="keepInvalid(p)" :id="`keep-err-${p.origin}`" class="error-text">{{ t('storage.policies.keepError') }}</small>
          </label>
          <label class="cell">
            <span>{{ t('storage.policies.anchor') }}</span>
            <select v-model="p.anchor" class="field" @change="touched(p)">
              <option v-for="a in STORAGE_RETENTION_ANCHORS" :key="a" :value="a">{{ t(`storage.policies.anchorOf.${a}`) }}</option>
            </select>
          </label>
          <label class="cell">
            <span>{{ t('storage.policies.action') }}</span>
            <select v-model="p.action" class="field" @change="touched(p)">
              <option v-for="a in STORAGE_RETENTION_ACTIONS" :key="a" :value="a">{{ t(`storage.policies.actionOf.${a}`) }}</option>
            </select>
          </label>
          <label class="cell">
            <span>{{ t('storage.policies.warn') }}</span>
            <input v-model.number="p.warnDaysBefore" type="number" min="0" max="90" class="field">
          </label>
          <label class="cell">
            <span>{{ t('storage.policies.trashDays') }}</span>
            <input v-model.number="p.trashDays" type="number" min="1" max="365" class="field">
          </label>
          <label class="cell check">
            <input v-model="p.keepEvidence" type="checkbox" @change="touched(p)">
            <span>{{ t('storage.policies.keepEvidence') }}</span>
          </label>
        </div>
        <p v-if="p.enabled && p.action === 'purge'" class="note coral">{{ t('storage.policies.purgeWarning') }}</p>
        <label v-if="deleting(p) && !p.keepEvidence" class="ack">
          <input v-model="p.acknowledgeEvidence" type="checkbox">
          <span>{{ t('storage.policies.evidenceAck') }}</span>
        </label>
        <p v-if="dryRuns[p.origin]" class="help will-free">{{ t('storage.policies.willFree', { size: formatBytes(dryRuns[p.origin]!.bytes) }) }}</p>
      </fieldset>

      <p v-if="dryRunFailed" class="error-text" role="alert">{{ t('storage.policies.dryRunError') }}</p>
      <label v-if="firstOn.length && dryRunDone" class="ack">
        <input v-model="confirmVolume" type="checkbox">
        <span>{{ t('storage.policies.confirmVolume') }}</span>
      </label>
      <p v-if="firstOn.length && !dryRunDone" class="help">{{ t('storage.policies.dryRunRequired') }}</p>
      <p v-if="notice" class="note teal" role="status">{{ notice }}</p>
      <p v-if="error" class="error-text" role="alert">{{ error }}</p>

      <div class="actions">
        <button type="button" class="btn ghost" :disabled="busy" @click="dryRun">{{ t('storage.policies.dryRun') }}</button>
        <button type="submit" class="btn primary" :disabled="!canSave">{{ t('storage.policies.save') }}</button>
      </div>
    </form>
  </div>
</template>

<style scoped>
.intro { margin: 0 0 var(--space-3); }
.policies { display: grid; gap: var(--space-3); }
.policy { border: 1px solid var(--color-bg-line-soft); margin: 0; min-width: 0; display: grid; gap: var(--space-3); }
.policy.on { border-color: var(--color-teal); }
.policy-head { display: flex; justify-content: space-between; align-items: center; gap: var(--space-3); flex-wrap: wrap; }
.policy-name { font-weight: 900; }
.grid { display: grid; grid-template-columns: repeat(auto-fit, minmax(150px, 1fr)); gap: var(--space-3); align-items: end; }
.cell { display: grid; gap: var(--space-1); font-size: var(--font-size-body-s); font-weight: 700; color: var(--color-ink-muted); }
.cell .field { padding: var(--space-2) var(--space-3); }
.cell.check { display: flex; gap: var(--space-2); align-items: center; color: var(--color-ink); padding-bottom: var(--space-2); }
.ack { display: flex; gap: var(--space-2); align-items: flex-start; font-weight: 700; font-size: var(--font-size-body-s); }
.will-free { margin: 0; font-weight: 800; color: var(--color-teal-ink); }
.policy .note { margin: 0; }
.actions { display: flex; gap: var(--space-2); flex-wrap: wrap; justify-content: flex-end; position: sticky; bottom: 0; background: var(--color-bg); padding: var(--space-3) 0; }
.sr-only { position: absolute; width: 1px; height: 1px; overflow: hidden; clip: rect(0 0 0 0); white-space: nowrap; }
</style>
