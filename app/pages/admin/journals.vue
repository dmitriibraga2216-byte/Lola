<script setup lang="ts">
definePageMeta({ layout: 'admin', middleware: 'admin-scope', requiredScope: 'audit.view' })

/**
 * Журналы (docs/22 §5, §13.4). «Безпека» и «Сесії» — по мокапам SecurityLog/SessionsLog:
 * дата · людина (посада · точка) · рівень · подія · IP з геолокацією · браузер.
 * Остальные журналы — общая таблица по колонкам ответа. Технический контекст (ip, geo, client)
 * приходит одинаково для всех журналов (CLAUDE.md п. 14).
 */
const { t, te } = useI18n()
const { api, apiRaw } = useApi()
type Kind = 'task-status' | 'task-access' | 'org-conflicts' | 'notifications' | 'sessions' | 'security' | 'import' | 'automation' | 'integrations'
type Severity = 'info' | 'warning' | 'critical'
type Geo = { country?: string | null, city?: string | null } | null
type Row = Record<string, unknown> & { id: unknown, full_name?: string | null, position?: string | null, unit?: string | null, ip?: string | null, geo?: Geo, client?: string | null }
const KINDS: Kind[] = ['task-status', 'task-access', 'org-conflicts', 'notifications', 'sessions', 'security', 'import', 'automation', 'integrations']
const SEVERITIES: Severity[] = ['info', 'warning', 'critical']
const route = useRoute()
const { hasScope } = useAuth()
const tab = ref<Kind>(KINDS.includes(String(route.query.tab) as Kind) ? String(route.query.tab) as Kind : 'security')
// «Повідомляти про зміни на E-mail» (docs/22 §13.4): письмо администраторам при warning и critical
const emailAlerts = ref(false)
const settingsError = ref('')
async function toggleEmailAlerts(v: boolean) {
  settingsError.value = ''
  try { emailAlerts.value = (await api<{ emailAlerts: boolean }>('/settings/security', { method: 'PATCH', body: { emailAlerts: v } })).emailAlerts }
  catch (err) { settingsError.value = apiErrorOf(err).message }
}
const rows = ref<Row[]>([])
const retention = ref<number | null>(0)
const error = ref('')
const filters = reactive({ from: '', to: '', userId: '', type: '', severity: '', contentType: '' })
const CONTENT_TYPES = ['course', 'training_program', 'test', 'resource']
const CONFLICT_KINDS = ['double_unit', 'placement_replaced', 'manager_self', 'manager_cycle']
const people = ref<{ id: string, fullName: string }[]>([])
const search = ref('')
const opened = ref<string | null>(null)

const query = () => Object.fromEntries(Object.entries(filters).filter(([k, v]) => v && (k !== 'severity' || tab.value === 'security') && (k !== 'contentType' || tab.value === 'task-status' || tab.value === 'task-access')))
async function load() {
  error.value = ''
  try {
    const r = await api<{ rows: Row[], retentionDays: number | null }>(`/logs/${tab.value}`, { query: query() })
    rows.value = r.rows; retention.value = r.retentionDays
  }
  catch (err) { error.value = apiErrorOf(err).message }
}
watch(tab, load)
watch(filters, load)
onMounted(async () => { await load(); emailAlerts.value = (await api<{ emailAlerts: boolean }>('/settings/security').catch(() => ({ emailAlerts: false }))).emailAlerts })
let timer: ReturnType<typeof setTimeout>
watch(search, (v) => { clearTimeout(timer); if (!v.trim()) { people.value = []; return } timer = setTimeout(async () => { try { people.value = (await apiRaw<{ data: { id: string, fullName: string }[] }>('/people', { query: { q: v, tab: 'all', limit: 8 } })).data } catch { people.value = [] } }, 300) })

const HIDDEN = ['id', 'user_id', 'meta', 'payload', 'response_body', 'actions_result', 'trigger_payload', 'rendered_text', 'stats', 'entity_id', 'user_status', 'details', 'import_job_id', 'assignment_id', 'content_id', 'actor_id']
// Единый каркас (docs/22 §13.3): колонки человека рисует ReportFrame, в общей таблице они не дублируются
const FRAME = ['full_name', 'position', 'city', 'unit', 'location', 'tags', 'assigned_at', 'completed_at', 'status', 'result']
const hasFrame = computed(() => !!rows.value[0] && 'full_name' in rows.value[0] && 'city' in rows.value[0])
// Подія протокола статусов — текст по коду события (мокап StatusLog: «Користувач пройшов завдання», «Спроба 2 з 3 неуспішна»)
const statusEventText = (r: Row) => {
  const code = String(r.event ?? '')
  const p = (r.payload ?? {}) as { attemptNo?: number, attemptsAllowed?: string | null }
  if (code.startsWith('attempt.')) return t(`journals.statusEvent.${code.replace('.', '_')}_${r.status === 'done' ? 'ok' : r.status === 'failed' ? 'fail' : 'review'}`, { n: p.attemptNo ?? '', of: p.attemptsAllowed && p.attemptsAllowed !== '0' ? p.attemptsAllowed : '∞' })
  const key = `journals.statusEvent.${code}`
  return te(key) ? t(key) : code
}
const columns = computed(() => rows.value[0] ? Object.keys(rows.value[0]).filter(k => !HIDDEN.includes(k) && !(hasFrame.value && FRAME.includes(k))) : [])
// Даты из журналов приходят строкой Postgres («2026-09-19 20:50:39.85+00») или ISO
const isDate = (v: unknown): v is string => typeof v === 'string' && /^\d{4}-\d{2}-\d{2}[T ]\d{2}:\d{2}/.test(v)
const parseDate = (v: string) => new Date(v.replace(' ', 'T').replace(/([+-]\d{2})$/, '$1:00'))
const dateOf = (v: unknown) => isDate(v) ? parseDate(v).toLocaleDateString('uk', { day: '2-digit', month: '2-digit', year: 'numeric' }) : '—'
const timeOf = (v: unknown) => isDate(v) ? parseDate(v).toLocaleTimeString('uk', { hour: '2-digit', minute: '2-digit' }) : '—'
const geoOf = (g: Geo) => g ? [g.country, g.city].filter(Boolean).join(', ') : ''
const fmt = (v: unknown) => v == null || v === '' ? '—' : (typeof v === 'object' && v && 'country' in (v as object)) ? geoOf(v as Geo) || '—' : isDate(v) ? parseDate(v).toLocaleString('uk', { dateStyle: 'short', timeStyle: 'short' }) : typeof v === 'object' ? JSON.stringify(v) : String(v)
// Подія — человеческий текст по коду события; неизвестный код показываем как есть
const eventText = (r: Row) => {
  const code = String(r.event ?? '')
  const key = `journals.eventText.${code.replace(/\./g, '_')}` // точки в коде события — не путь в словаре
  const base = te(key) ? t(key) : code
  const reason = (r.meta as { reason?: unknown } | undefined)?.reason
  return typeof reason === 'string' && reason && code.startsWith('impersonation') ? `${base} · ${t('journals.reason')}: ${reason}` : base
}
const minutes = (r: Row) => isDate(r.created_at) && isDate(r.ended_at) ? Math.max(0, Math.round((parseDate(r.ended_at).getTime() - parseDate(r.created_at).getTime()) / 60000)) : 0
const uniquePeople = computed(() => new Set(rows.value.map(r => String(r.user_id))).size)
const exportUrl = computed(() => `/api/v1/logs/${tab.value}?${new URLSearchParams({ ...query(), limit: '500', format: 'xlsx' })}`)
const retentionText = computed(() => retention.value == null ? t('journals.retentionForever') : t('journals.retention', { days: retention.value }))
</script>

<template>
  <div>
    <PageHeader :title="t(`journals.title.${tab}`)" :crumbs="[{ label: t('journals.crumb') }]" :subtitle="`${retentionText} · ${t('journals.immutable')}`">
      <template #actions>
        <a v-if="hasScope('report.export')" :href="exportUrl" class="btn-ghost" download>{{ t('journals.export') }}</a>
      </template>
    </PageHeader>
    <div class="tabs" role="tablist">
      <button v-for="k in KINDS" :key="k" role="tab" :aria-selected="tab === k" :class="['tab', { on: tab === k }]" @click="tab = k">{{ t(`journals.kind.${k}`) }}</button>
    </div>
    <div class="filters">
      <label>{{ t('reports.from') }} <input v-model="filters.from" type="date"></label>
      <label>{{ t('reports.to') }} <input v-model="filters.to" type="date"></label>
      <label v-if="tab === 'security'">{{ t('journals.col.severity') }}
        <select v-model="filters.severity">
          <option value="">{{ t('journals.severity.any') }}</option>
          <option v-for="s in SEVERITIES" :key="s" :value="s">{{ t(`journals.severity.${s}`) }}</option>
        </select>
      </label>
      <label v-if="tab === 'task-status' || tab === 'task-access'">{{ t('journals.col.content_type') }}
        <select v-model="filters.contentType">
          <option value="">{{ t('journals.anyType') }}</option>
          <option v-for="ct in CONTENT_TYPES" :key="ct" :value="ct">{{ t(`contentType.${ct}`) }}</option>
        </select>
      </label>
      <label v-if="tab === 'org-conflicts'">{{ t('journals.col.kind') }}
        <select v-model="filters.type">
          <option value="">{{ t('journals.anyType') }}</option>
          <option v-for="k in CONFLICT_KINDS" :key="k" :value="k">{{ t(`journals.conflict.${k}`) }}</option>
        </select>
      </label>
      <label v-else-if="tab !== 'sessions' && tab !== 'task-access'">{{ t('journals.type') }} <input v-model="filters.type" :placeholder="t('journals.typeHint')"></label>
      <label v-if="tab === 'security' && hasScope('settings.tenant')" class="toggle"><input type="checkbox" :checked="emailAlerts" @change="toggleEmailAlerts(($event.target as HTMLInputElement).checked)"><span>{{ t('journals.emailAlerts') }}<span class="hint">{{ t('journals.emailAlertsHint') }}</span></span></label>
      <label>{{ t('people.col.name') }} <input v-model="search" :placeholder="t('orgAdmin.searchPerson')"></label>
      <div v-if="people.length" class="found"><button v-for="p in people" :key="p.id" class="chip" @click="filters.userId = p.id; search = p.fullName; people = []">{{ p.fullName }}</button></div>
      <button v-if="filters.userId" class="chip" @click="filters.userId = ''; search = ''">× {{ search }}</button>
    </div>
    <div v-if="tab === 'sessions' && rows.length" class="stats">
      <div class="stat"><span class="stat-label">{{ t('journals.uniquePeople') }}</span><strong class="stat-value">{{ uniquePeople }}</strong></div>
      <div class="stat"><span class="stat-label">{{ t('journals.sessionsCount') }}</span><strong class="stat-value">{{ rows.length }}</strong></div>
    </div>
    <p v-if="error" class="error" role="alert">{{ error }}</p>
    <p v-if="settingsError" class="error" role="alert">{{ settingsError }}</p>
    <div class="table-wrap">
      <!-- Протокол змін статусу завдань — мокап StatusLog: дата · людина (каркас) · завдання · тип · стан · результат · подія -->
      <table v-if="rows.length && tab === 'task-status'" class="table">
        <thead><tr><th>{{ t('journals.col.when') }}</th><ReportFrame part="head" /><th>{{ t('journals.col.task') }}</th><th>{{ t('journals.col.content_type') }}</th><th>{{ t('journals.col.event') }}</th><th /></tr></thead>
        <tbody>
          <template v-for="r in rows" :key="String(r.id)">
            <tr>
              <td>{{ dateOf(r.created_at) }}<div class="sub">{{ timeOf(r.created_at) }}</div></td>
              <ReportFrame part="cells" :row="r" />
              <td class="event">{{ r.task_title ?? '—' }}</td>
              <td>{{ t(`contentType.${r.content_type}`) }}</td>
              <td class="event">{{ statusEventText(r) }}<div v-if="r.from_status" class="sub">{{ t(`enrollment.${r.from_status}`) }} → {{ t(`enrollment.${r.status}`) }}</div></td>
              <td><button class="chip" :aria-expanded="opened === String(r.id)" @click="opened = opened === String(r.id) ? null : String(r.id)">{{ t('journals.details') }}</button></td>
            </tr>
            <tr v-if="opened === String(r.id)"><td colspan="15"><pre class="pre">{{ JSON.stringify(r, null, 2) }}</pre></td></tr>
          </template>
        </tbody>
      </table>
      <!-- Звіт звернень до завдань — каждое открытие: дата · тип · завдання · людина (каркас) · дія · IP · браузер -->
      <table v-else-if="rows.length && tab === 'task-access'" class="table">
        <thead><tr><th>{{ t('journals.col.when') }}</th><th>{{ t('journals.col.content_type') }}</th><th>{{ t('journals.col.task') }}</th><ReportFrame part="head" :tail="false" /><th>{{ t('journals.col.action') }}</th><th>{{ t('journals.col.ip') }}</th><th>{{ t('journals.col.client') }}</th></tr></thead>
        <tbody>
          <tr v-for="r in rows" :key="String(r.id)">
            <td>{{ dateOf(r.created_at) }}<div class="sub">{{ timeOf(r.created_at) }}</div></td>
            <td>{{ t(`contentType.${r.content_type}`) }}</td>
            <td class="event">{{ r.task_title ?? '—' }}</td>
            <ReportFrame part="cells" :row="r" :tail="false" />
            <td>{{ t(`journals.access.${r.action}`) }}</td>
            <td class="mono">{{ r.ip ?? '—' }}<div v-if="geoOf(r.geo ?? null)" class="sub">{{ geoOf(r.geo ?? null) }}</div></td>
            <td>{{ r.client ?? '—' }}</td>
          </tr>
        </tbody>
      </table>
      <!-- Протокол конфліктів в оргструктурі -->
      <table v-else-if="rows.length && tab === 'org-conflicts'" class="table">
        <thead><tr><th>{{ t('journals.col.when') }}</th><ReportFrame part="head" :tail="false" /><th>{{ t('journals.col.kind') }}</th><th>{{ t('journals.col.source') }}</th><th>{{ t('journals.col.actor') }}</th><th /></tr></thead>
        <tbody>
          <template v-for="r in rows" :key="String(r.id)">
            <tr>
              <td>{{ dateOf(r.created_at) }}<div class="sub">{{ timeOf(r.created_at) }}</div></td>
              <ReportFrame part="cells" :row="r" :tail="false" />
              <td class="event">{{ t(`journals.conflict.${r.kind}`) }}</td>
              <td>{{ t(`journals.conflictSource.${r.source}`) }}</td>
              <td>{{ r.actor ?? '—' }}</td>
              <td><button class="chip" :aria-expanded="opened === String(r.id)" @click="opened = opened === String(r.id) ? null : String(r.id)">{{ t('journals.details') }}</button></td>
            </tr>
            <tr v-if="opened === String(r.id)"><td colspan="10"><pre class="pre">{{ JSON.stringify(r.details, null, 2) }}</pre></td></tr>
          </template>
        </tbody>
      </table>
      <!-- Журнал безпеки — колонки мокапа SecurityLog -->
      <table v-else-if="rows.length && tab === 'security'" class="table">
        <thead><tr><th>{{ t('journals.col.when') }}</th><ReportFrame part="head" :tail="false" /><th>{{ t('journals.col.severity') }}</th><th>{{ t('journals.col.event') }}</th><th>{{ t('journals.col.ip') }}</th><th>{{ t('journals.col.client') }}</th><th /></tr></thead>
        <tbody>
          <template v-for="r in rows" :key="String(r.id)">
            <tr>
              <td>{{ dateOf(r.created_at) }}<div class="sub">{{ timeOf(r.created_at) }}</div></td>
              <ReportFrame part="cells" :row="r" :tail="false" />
              <td><span :class="['pill', `pill-${r.severity}`]">{{ t(`journals.severity.${r.severity}`) }}</span></td>
              <td class="event">{{ eventText(r) }}</td>
              <td class="mono">{{ r.ip ?? '—' }}<div v-if="geoOf(r.geo ?? null)" class="sub">{{ geoOf(r.geo ?? null) }}</div></td>
              <td>{{ r.client ?? '—' }}</td>
              <td><button class="chip" :aria-expanded="opened === String(r.id)" @click="opened = opened === String(r.id) ? null : String(r.id)">{{ t('journals.details') }}</button></td>
            </tr>
            <tr v-if="opened === String(r.id)"><td colspan="11"><pre class="pre">{{ JSON.stringify(r, null, 2) }}</pre></td></tr>
          </template>
        </tbody>
      </table>
      <!-- Журнал сесій — колонки мокапа SessionsLog -->
      <table v-else-if="rows.length && tab === 'sessions'" class="table">
        <thead><tr><th>{{ t('journals.col.session_time') }}</th><ReportFrame part="head" :tail="false" /><th>{{ t('journals.col.ip') }}</th><th>{{ t('journals.col.client') }}</th><th /></tr></thead>
        <tbody>
          <template v-for="r in rows" :key="String(r.id)">
            <tr>
              <td>{{ dateOf(r.created_at) }} {{ timeOf(r.created_at) }} — {{ r.active ? t('journals.activeNow') : timeOf(r.ended_at) }}<div class="sub">{{ t('journals.minutes', { n: minutes(r) }) }}</div></td>
              <ReportFrame part="cells" :row="r" :tail="false" />
              <td class="mono">{{ r.ip ?? '—' }}<div v-if="geoOf(r.geo ?? null)" class="sub">{{ geoOf(r.geo ?? null) }}</div></td>
              <td>{{ r.client ?? '—' }}</td>
              <td><button class="chip" :aria-expanded="opened === String(r.id)" @click="opened = opened === String(r.id) ? null : String(r.id)">{{ t('journals.details') }}</button></td>
            </tr>
            <tr v-if="opened === String(r.id)"><td colspan="9"><pre class="pre">{{ JSON.stringify(r, null, 2) }}</pre></td></tr>
          </template>
        </tbody>
      </table>
      <table v-else-if="rows.length" class="table">
        <thead><tr><ReportFrame v-if="hasFrame" part="head" :tail="false" /><th v-for="c in columns" :key="c">{{ t(`journals.col.${c}`, c) }}</th><th /></tr></thead>
        <tbody>
          <template v-for="r in rows" :key="String(r.id)">
            <tr><ReportFrame v-if="hasFrame" part="cells" :row="r" :tail="false" /><td v-for="c in columns" :key="c" :class="{ mono: c === 'action' || c === 'event' || c === 'code' || c === 'ip' }">{{ fmt(r[c]) }}</td><td><button class="chip" :aria-expanded="opened === String(r.id)" @click="opened = opened === String(r.id) ? null : String(r.id)">{{ t('journals.details') }}</button></td></tr>
            <tr v-if="opened === String(r.id)"><td :colspan="columns.length + 6"><pre class="pre">{{ JSON.stringify(r, null, 2) }}</pre></td></tr>
          </template>
        </tbody>
      </table>
      <p v-else class="sub">{{ t('reports.noData') }}</p>
    </div>
  </div>
</template>

<style scoped>
.tabs { display: flex; gap: var(--space-2); margin-bottom: var(--space-2); flex-wrap: wrap; }
.tab { font: inherit; font-weight: 700; border: 1px solid var(--color-bg-line); background: transparent; color: var(--color-ink-muted); border-radius: var(--radius-pill); padding: var(--space-1) var(--space-4); cursor: pointer; }
.tab.on { background: var(--color-ink); border-color: var(--color-ink); color: var(--color-bg-soft); }
.filters { display: flex; gap: var(--space-3); align-items: end; flex-wrap: wrap; margin: var(--space-2) 0 var(--space-3); }
.filters label { display: grid; gap: var(--space-1); font-size: var(--font-size-body-s); color: var(--color-ink-muted); }
.filters .toggle { display: inline-flex; align-self: center; color: var(--color-ink); }
.filters .toggle input[type="checkbox"] { appearance: none; border: none; padding: 0; background: var(--color-bg-line); }
.filters .toggle input[type="checkbox"]:checked { background: var(--color-teal); }
input, select { font: inherit; border: 1px solid var(--color-bg-line); border-radius: var(--radius-s); padding: var(--space-1) var(--space-2); background: var(--color-bg); color: var(--color-ink); }
.found { display: flex; gap: var(--space-1); flex-wrap: wrap; }
.chip { font: inherit; font-size: var(--font-size-body-s); font-weight: 700; border: 1px solid var(--color-bg-line); background: transparent; color: var(--color-ink-muted); border-radius: var(--radius-pill); padding: var(--space-1) var(--space-3); cursor: pointer; text-decoration: none; }
.btn-ghost { font: inherit; font-weight: 800; border: 1px solid var(--color-ink); color: var(--color-ink); background: transparent; border-radius: var(--radius-pill); padding: var(--space-2) var(--space-4); text-decoration: none; }
.stats { display: flex; gap: var(--space-3); flex-wrap: wrap; margin-bottom: var(--space-3); }
.stat { display: grid; gap: var(--space-1); padding: var(--space-3) var(--space-4); background: var(--color-bg-soft); border-radius: var(--radius-m); min-width: 160px; }
.stat-label { font-size: var(--font-size-body-s); color: var(--color-ink-muted); font-weight: 700; }
.stat-value { font-size: var(--font-size-title-l); font-weight: 900; color: var(--color-teal-ink); }
.table-wrap { overflow-x: auto; }
.table { width: 100%; border-collapse: collapse; background: var(--color-bg-soft); border-radius: var(--radius-m); overflow: hidden; }
th { text-align: left; font-size: var(--font-size-body-s); color: var(--color-ink-muted); padding: var(--space-2) var(--space-3); border-bottom: 1px solid var(--color-bg-line); white-space: nowrap; text-transform: uppercase; letter-spacing: 0.04em; }
td { padding: var(--space-3) var(--space-3); border-bottom: 1px solid var(--color-bg-line-soft); vertical-align: middle; font-size: var(--font-size-body); max-width: 320px; overflow: hidden; text-overflow: ellipsis; }
.event { max-width: 360px; white-space: normal; }
.mono { font-family: ui-monospace, monospace; }
.pill { display: inline-block; padding: var(--space-1) var(--space-3); border-radius: var(--radius-pill); font-size: var(--font-size-body-s); font-weight: 800; white-space: nowrap; }
/* Рівень: звичайний — беж, увага — солнце, критично — коралл (бренд-бук, мокап SecurityLog) */
.pill-info { background: var(--color-bg-line-soft); color: var(--color-ink-muted); }
.pill-warning { background: var(--color-sun); color: var(--color-ink); }
.pill-critical { background: var(--color-coral); color: var(--color-ink); }
.pre { margin: 0; white-space: pre-wrap; font-size: var(--font-size-body-s); max-height: 300px; overflow: auto; }
.sub { font-size: var(--font-size-body-s); color: var(--color-ink-muted); }
.error { color: var(--color-coral-ink); }
</style>
