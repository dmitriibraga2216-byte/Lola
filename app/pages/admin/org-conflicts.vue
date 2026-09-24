<script setup lang="ts">
definePageMeta({ layout: 'admin', middleware: 'admin-scope', requiredScope: 'people.edit' })

/**
 * «Протокол конфліктів в оргструктурі» (мокап OrgConflicts, docs/16 §7, §14): Дата · Людина · Конфлікт · Деталі · Стан.
 * Импорт не падает на конфликте — пишет строку и продолжает; здесь конфликт разрешают: принять как есть
 * или закрыть одно из размещений («людина у двох підрозділах»).
 */
const { t } = useI18n()
const { formatShortDate } = useFormat()
const { api } = useApi()
const route = useRoute()

type Kind = 'double_unit' | 'placement_replaced' | 'manager_self' | 'manager_cycle' | 'unit_missing'
type State = 'open' | 'resolved' | 'all'
interface Row { id: string, created_at: string, user_id: string | null, full_name: string | null, position: string | null, location: string | null, unit: string | null, kind: Kind, source: 'manual' | 'import', details: Record<string, unknown>, resolved_at: string | null, actor: string | null }
interface Placement { id: string, is_primary: boolean, started_at: string, location: string, position: string, unit: string | null }
const KINDS: Kind[] = ['double_unit', 'placement_replaced', 'manager_self', 'manager_cycle', 'unit_missing']

const state = ref<State>((['open', 'resolved', 'all'] as string[]).includes(String(route.query.state)) ? route.query.state as State : 'open')
const kind = ref<Kind | ''>('')
const rows = ref<Row[]>([])
const error = ref('')
const notice = ref('')
const resolving = ref<Row | null>(null)
const placements = ref<Placement[]>([])
const resolveForm = reactive({ action: 'acknowledge' as 'acknowledge' | 'close_placement', placementId: '', comment: '' })
const busy = ref(false)

async function load() {
  error.value = ''
  try { rows.value = (await api<{ rows: Row[] }>('/org-conflicts', { query: { state: state.value, ...(kind.value ? { kind: kind.value } : {}) } })).rows }
  catch (err) { error.value = apiErrorOf(err).message }
}
watch([state, kind], load)
onMounted(load)

async function openResolve(r: Row) {
  resolving.value = r
  Object.assign(resolveForm, { action: r.kind === 'double_unit' ? 'close_placement' : 'acknowledge', placementId: '', comment: '' })
  placements.value = r.user_id ? await api<Placement[]>(`/org-conflicts/${r.id}/placements`).catch(() => []) : []
}
async function resolve() {
  if (!resolving.value) return
  busy.value = true
  error.value = ''
  try {
    await api(`/org-conflicts/${resolving.value.id}/resolve`, { method: 'POST', body: { action: resolveForm.action, placementId: resolveForm.action === 'close_placement' ? resolveForm.placementId : null, comment: resolveForm.comment || null } })
    notice.value = t('conflicts.resolved')
    resolving.value = null
    await load()
  }
  catch (err) { error.value = apiErrorOf(err).message }
  finally { busy.value = false }
}

const parseDate = (v: string) => new Date(v.replace(' ', 'T').replace(/([+-]\d{2})$/, '$1:00'))
const dateOf = (v: string | null) => v ? formatShortDate(parseDate(v)) : '—'
/** Деталі — коротко по виду конфликта (мокап: «Б9 Лазарева, Б12 Меркурій», «Б14 (немає)») */
function detailsOf(r: Row): string {
  const d = r.details
  if (r.kind === 'unit_missing') return `${d.orgUnit ?? '—'} (${t('conflicts.missing')})${d.line ? ` · ${t('conflicts.line', { n: d.line })}` : ''}`
  if (r.kind === 'placement_replaced') return `${(d.from as Record<string, string> | undefined)?.locationId ? t('conflicts.replacedFrom') : ''} → ${r.location ?? ''}`.trim()
  if (r.kind === 'double_unit') return [r.unit, d.otherOrgUnitId ? t('conflicts.otherUnit') : null].filter(Boolean).join(', ')
  if (r.kind === 'manager_cycle') return String(d.chiefName ?? d.chiefId ?? '')
  return r.unit ?? '—'
}
</script>

<template>
  <div>
    <PageHeader :title="t('conflicts.title')" :crumbs="[{ label: t('admin.nav.people'), to: '/admin/people' }]" :subtitle="t('conflicts.hint')" />

    <div class="filters">
      <div class="chips" role="tablist">
        <button v-for="s in (['open', 'resolved', 'all'] as State[])" :key="s" role="tab" :aria-selected="state === s" :class="['chip', { on: state === s }]" @click="state = s">{{ t(`conflicts.state.${s}`) }}</button>
      </div>
      <label>{{ t('conflicts.col.kind') }}
        <select v-model="kind"><option value="">{{ t('journals.anyType') }}</option><option v-for="k in KINDS" :key="k" :value="k">{{ t(`journals.conflict.${k}`) }}</option></select>
      </label>
    </div>

    <p v-if="error" class="error" role="alert">{{ error }}</p>
    <p v-if="notice" class="notice" role="status">{{ notice }}</p>

    <div class="table-wrap">
      <table class="table">
        <thead><tr><th>{{ t('conflicts.col.date') }}</th><th>{{ t('conflicts.col.person') }}</th><th>{{ t('conflicts.col.kind') }}</th><th>{{ t('conflicts.col.details') }}</th><th>{{ t('conflicts.col.source') }}</th><th>{{ t('conflicts.col.state') }}</th><th /></tr></thead>
        <tbody>
          <tr v-for="r in rows" :key="r.id">
            <td class="nowrap">{{ dateOf(r.created_at) }}</td>
            <td>
              <NuxtLink v-if="r.user_id" :to="`/admin/people/${r.user_id}`" class="link">{{ r.full_name }}</NuxtLink>
              <span v-else>{{ (r.details.fullName as string) || '—' }}</span>
              <div v-if="r.position" class="sub">{{ r.position }}<template v-if="r.location"> · {{ r.location }}</template></div>
            </td>
            <td class="event">{{ t(`journals.conflict.${r.kind}`) }}</td>
            <td class="event">{{ detailsOf(r) }}</td>
            <td>{{ t(`journals.conflictSource.${r.source}`) }}</td>
            <td><span :class="['pill', r.resolved_at ? 'pill-ok' : 'pill-open']">{{ r.resolved_at ? t('conflicts.state.resolved') : t('conflicts.state.open') }}</span></td>
            <td><button v-if="!r.resolved_at" class="btn small" @click="openResolve(r)">{{ t('conflicts.resolve') }}</button></td>
          </tr>
          <tr v-if="rows.length === 0"><td colspan="7" class="sub">{{ t('conflicts.empty') }}</td></tr>
        </tbody>
      </table>
    </div>

    <div v-if="resolving" class="overlay" @click.self="resolving = null">
      <form class="modal" role="dialog" aria-modal="true" @submit.prevent="resolve">
        <h2>{{ t('conflicts.resolveTitle') }}</h2>
        <p class="sub">{{ resolving.full_name }} · {{ t(`journals.conflict.${resolving.kind}`) }}</p>
        <label class="check"><input v-model="resolveForm.action" type="radio" value="acknowledge"> {{ t('conflicts.acknowledge') }}</label>
        <label v-if="placements.length > 1" class="check"><input v-model="resolveForm.action" type="radio" value="close_placement"> {{ t('conflicts.closePlacement') }}</label>
        <label v-if="resolveForm.action === 'close_placement'">{{ t('conflicts.whichPlacement') }}
          <select v-model="resolveForm.placementId" required>
            <option value="" disabled>—</option>
            <option v-for="p in placements" :key="p.id" :value="p.id">{{ p.position }} · {{ p.location }}{{ p.unit ? ` · ${p.unit}` : '' }}{{ p.is_primary ? ` (${t('conflicts.primary')})` : '' }}</option>
          </select>
        </label>
        <label>{{ t('person.comment') }}<input v-model="resolveForm.comment" maxlength="500"></label>
        <div class="modal-actions">
          <button type="button" class="btn" @click="resolving = null">{{ t('common.cancel') }}</button>
          <button type="submit" class="btn primary" :disabled="busy || (resolveForm.action === 'close_placement' && !resolveForm.placementId)">{{ t('conflicts.resolve') }}</button>
        </div>
      </form>
    </div>
  </div>
</template>

<style scoped>
.filters { display: flex; gap: var(--space-3); align-items: end; flex-wrap: wrap; margin-bottom: var(--space-3); }
.filters label { display: grid; gap: var(--space-1); font-size: var(--font-size-body-s); color: var(--color-ink-muted); }
.chips { display: flex; gap: var(--space-2); flex-wrap: wrap; }
.chip { font: inherit; font-size: var(--font-size-body-s); font-weight: 700; border: 1px solid var(--color-bg-line); background: transparent; color: var(--color-ink-muted); border-radius: var(--radius-pill); padding: var(--space-1) var(--space-3); cursor: pointer; }
.chip.on { background: var(--color-ink); border-color: var(--color-ink); color: var(--color-bg-soft); }
input, select { font: inherit; border: 1px solid var(--color-bg-line); border-radius: var(--radius-s); padding: var(--space-1) var(--space-2); background: var(--color-bg); color: var(--color-ink); max-width: 100%; box-sizing: border-box; }
.btn { font: inherit; font-weight: 700; border: 1px solid var(--color-bg-line); background: var(--color-bg-soft); color: var(--color-ink); border-radius: var(--radius-pill); padding: var(--space-1) var(--space-4); cursor: pointer; }
.btn.primary { background: var(--color-sun); border-color: var(--color-sun); }
.btn.small { font-size: var(--font-size-body-s); padding: 0 var(--space-3); }
.btn:disabled { opacity: 0.5; }
.table-wrap { overflow-x: auto; }
.table { width: 100%; border-collapse: collapse; background: var(--color-bg-soft); border-radius: var(--radius-m); overflow: hidden; }
th { text-align: left; font-size: var(--font-size-body-s); color: var(--color-ink-muted); padding: var(--space-2) var(--space-3); border-bottom: 1px solid var(--color-bg-line); text-transform: uppercase; letter-spacing: 0.04em; white-space: nowrap; }
td { padding: var(--space-2) var(--space-3); border-bottom: 1px solid var(--color-bg-line-soft); vertical-align: middle; }
.nowrap { white-space: nowrap; }
.event { max-width: 320px; }
.link { color: var(--color-ink); font-weight: 700; text-decoration: none; }
.pill { display: inline-block; padding: 2px var(--space-3); border-radius: var(--radius-pill); font-size: var(--font-size-body-s); font-weight: 800; white-space: nowrap; }
.pill-open { background: var(--color-coral); color: var(--color-coral-deep); }
.pill-ok { background: var(--color-teal); color: var(--color-teal-deep); }
.sub { color: var(--color-ink-muted); font-size: var(--font-size-body-s); }
.error { color: var(--color-coral-ink); }
.notice { color: var(--color-teal-ink); }
.overlay { position: fixed; inset: 0; background: rgb(0 0 0 / 40%); display: grid; place-items: center; padding: var(--space-3); z-index: 20; }
.modal { background: var(--color-bg-soft); border-radius: var(--radius-l); padding: var(--space-4); display: grid; gap: var(--space-3); width: min(460px, 100%); box-sizing: border-box; }
.modal h2 { margin: 0; }
.modal label { display: grid; gap: var(--space-1); font-size: var(--font-size-body-s); color: var(--color-ink-muted); }
.modal .check { display: flex; align-items: center; gap: var(--space-2); color: var(--color-ink); }
.modal-actions { display: flex; gap: var(--space-2); justify-content: flex-end; flex-wrap: wrap; }
</style>
