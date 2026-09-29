<script setup lang="ts">
/**
 * Журнал ШІ-викликів — вкладка «Налаштування → Штучний інтелект» (docs/v2/30 §2, §5.6; API —
 * PR-27 `GET /ai/calls`, вивантаження — `GET /ai/calls/export`).
 *
 * Фільтри §5.6: призначення, статус, період, вартість. Вартість на екрані — у гривнях/євро
 * з копійками, у запиті — мінорні одиниці (`costMin`). Вихід моделі розгортається за кнопкою:
 * у ньому обґрунтування й цитати відповідей, тож він не показується «сам» і не потрапляє у файл.
 */
import { AI_CALL_STATUSES, AI_PURPOSES } from '#shared/enums'

interface Call {
  id: number
  createdAt: string
  purpose: string
  promptKey: string
  promptVersion: string
  providerName: string | null
  modelName: string
  modelVersion: string | null
  refKind: string
  status: string
  errorCode: string | null
  latencyMs: number | null
  tokensIn: number | null
  tokensOut: number | null
  costMinor: number
  currency: string
  billed: boolean
  tryNo: number
  output: unknown
}

const { t } = useI18n()
const { api } = useApi()
const { hasScope } = useAuth()
const { formatDateTime, formatNumber } = useFormat()

const filters = reactive({ purpose: '', status: '', from: '', to: '', cost: '' as number | '' })
const items = ref<Call[]>([])
const cursor = ref<string | null>(null)
const error = ref('')
const busy = ref(false)
const opened = ref<number | null>(null)

function query(): Record<string, string> {
  const q: Record<string, string> = {}
  if (filters.purpose) q.purpose = filters.purpose
  if (filters.status) q.status = filters.status
  if (filters.from) q.from = filters.from
  if (filters.to) q.to = filters.to
  if (filters.cost !== '') q.costMin = String(Math.round(Number(filters.cost) * 100))
  return q
}

async function load(more = false) {
  busy.value = true
  error.value = ''
  try {
    const r = await api<{ items: Call[], nextCursor: string | null }>('/ai/calls', { query: { ...query(), cursor: more ? cursor.value ?? undefined : undefined } })
    items.value = more ? [...items.value, ...r.items] : r.items
    cursor.value = r.nextCursor
  }
  catch (err) { error.value = apiErrorOf(err).message }
  finally { busy.value = false }
}
onMounted(() => load())

const exportUrl = (format: 'xlsx' | 'csv') => `/api/v1/ai/calls/export?${new URLSearchParams({ ...query(), format }).toString()}`
const money = (minor: number, currency: string) => `${formatNumber(minor / 100, { minimumFractionDigits: 2, maximumFractionDigits: 2 })} ${currency}`
const failed = (s: string) => ['failed', 'timeout', 'refused', 'degraded'].includes(s)
</script>

<template>
  <section class="panel stack">
    <div class="row between">
      <div>
        <h2 class="h2">{{ t('aiSettings.calls.title') }}</h2>
        <p class="sub">{{ t('aiSettings.calls.hint') }}</p>
      </div>
      <div v-if="hasScope('report.export')" class="row">
        <a class="btn ghost small" :href="exportUrl('xlsx')">{{ t('aiSettings.calls.exportXlsx') }}</a>
        <a class="btn ghost small" :href="exportUrl('csv')">{{ t('aiSettings.calls.exportCsv') }}</a>
      </div>
    </div>

    <p v-if="hasScope('report.export')" class="sub">{{ t('aiSettings.calls.exportLimit') }}</p>

    <form class="filters" @submit.prevent="load()">
      <label>{{ t('aiSettings.calls.purpose') }}
        <select v-model="filters.purpose" class="field">
          <option value="">{{ t('aiSettings.calls.any') }}</option>
          <option v-for="p in AI_PURPOSES" :key="p" :value="p">{{ t(`aiSettings.purpose.${p}`) }}</option>
        </select>
      </label>
      <label>{{ t('aiSettings.calls.status') }}
        <select v-model="filters.status" class="field">
          <option value="">{{ t('aiSettings.calls.any') }}</option>
          <option v-for="s in AI_CALL_STATUSES" :key="s" :value="s">{{ t(`aiSettings.callStatus.${s}`) }}</option>
        </select>
      </label>
      <label>{{ t('aiSettings.calls.from') }} <input v-model="filters.from" class="field" type="date"></label>
      <label>{{ t('aiSettings.calls.to') }} <input v-model="filters.to" class="field" type="date"></label>
      <label>{{ t('aiSettings.calls.costMin') }}
        <input v-model.number="filters.cost" class="field" type="number" min="0" step="0.01" inputmode="decimal">
      </label>
      <button class="btn primary" type="submit" :disabled="busy">{{ t('aiSettings.calls.apply') }}</button>
    </form>

    <p v-if="error" class="note coral" role="alert">{{ error }}</p>
    <p v-if="!busy && !items.length && !error" class="muted">{{ t('aiSettings.calls.empty') }}</p>

    <div v-if="items.length" class="table-wrap">
      <table class="table" :aria-busy="busy">
        <thead>
          <tr>
            <th>{{ t('aiSettings.calls.col.at') }}</th>
            <th>{{ t('aiSettings.calls.col.purpose') }}</th>
            <th>{{ t('aiSettings.calls.col.model') }}</th>
            <th>{{ t('aiSettings.calls.col.status') }}</th>
            <th class="num">{{ t('aiSettings.calls.col.latency') }}</th>
            <th class="num">{{ t('aiSettings.calls.col.tokens') }}</th>
            <th class="num">{{ t('aiSettings.calls.col.cost') }}</th>
            <th>{{ t('aiSettings.calls.col.output') }}</th>
          </tr>
        </thead>
        <tbody>
          <template v-for="c in items" :key="c.id">
            <tr>
              <td>{{ formatDateTime(c.createdAt) }}</td>
              <td>{{ t(`aiSettings.purpose.${c.purpose}`) }}<span class="sub block">{{ c.promptKey }} {{ c.promptVersion }}<template v-if="c.tryNo > 1"> · {{ t('aiSettings.calls.try', { n: c.tryNo }) }}</template></span></td>
              <td>{{ c.modelName }}<template v-if="c.modelVersion"> {{ c.modelVersion }}</template><span v-if="c.providerName" class="sub block">{{ c.providerName }}</span></td>
              <td>
                <span :class="['badge', failed(c.status) ? 'coral' : c.status === 'ok' ? 'teal' : '']">{{ t(`aiSettings.callStatus.${c.status}`) }}</span>
                <span v-if="c.errorCode" class="sub block">{{ c.errorCode }}</span>
              </td>
              <td class="num">{{ c.latencyMs === null ? '—' : formatNumber(c.latencyMs) }}</td>
              <td class="num">{{ c.tokensIn === null && c.tokensOut === null ? '—' : `${c.tokensIn ?? 0} / ${c.tokensOut ?? 0}` }}</td>
              <td class="num">{{ money(c.costMinor, c.currency) }}<span v-if="c.billed" class="sub block">{{ t('aiSettings.calls.billed') }}</span></td>
              <td>
                <button v-if="c.output !== null && c.output !== undefined" class="linkish" type="button" :aria-expanded="opened === c.id" @click="opened = opened === c.id ? null : c.id">
                  {{ opened === c.id ? t('aiSettings.calls.hideOutput') : t('aiSettings.calls.showOutput') }}
                </button>
                <span v-else class="sub">—</span>
              </td>
            </tr>
            <tr v-if="opened === c.id" class="drill">
              <td colspan="8"><pre class="output">{{ JSON.stringify(c.output, null, 2) }}</pre></td>
            </tr>
          </template>
        </tbody>
      </table>
    </div>
    <button v-if="cursor" class="btn ghost small" type="button" :disabled="busy" @click="load(true)">{{ t('aiSettings.more') }}</button>
  </section>
</template>

<style scoped>
.stack { display: grid; gap: var(--space-3); }
.row { display: flex; gap: var(--space-2); align-items: center; flex-wrap: wrap; }
.between { justify-content: space-between; }
.h2 { margin: 0 0 var(--space-1); font-size: var(--font-size-body); font-weight: 900; }
.sub { margin: 0; color: var(--color-ink-muted); font-size: var(--font-size-body-s); }
.block { display: block; }
.filters { display: flex; flex-wrap: wrap; gap: var(--space-2); align-items: end; }
.filters label { display: grid; gap: var(--space-1); font-size: var(--font-size-body-s); font-weight: 700; }
.filters .field { width: auto; min-width: 9rem; }
.linkish { font: inherit; font-weight: 700; color: var(--color-teal-ink); background: none; border: 0; padding: 0; cursor: pointer; text-align: left; }
.drill td { background: var(--color-bg); }
.output { margin: 0; white-space: pre-wrap; overflow-wrap: anywhere; font-size: var(--font-size-body-s); max-height: 20rem; overflow: auto; }
@media (max-width: 30rem) {
  .filters { flex-direction: column; align-items: stretch; }
  .filters .field { width: 100%; }
}
</style>
