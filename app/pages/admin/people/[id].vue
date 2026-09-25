<script setup lang="ts">
const { formatDateTime, formatShortDate } = useFormat()
definePageMeta({ layout: 'admin', middleware: 'admin-scope' })

const { t, te } = useI18n()
const { api } = useApi()
const { hasScope } = useAuth()
const route = useRoute()
const router = useRouter()
const id = route.params.id as string

interface Person {
  id: string, fullName: string, lastName: string | null, firstName: string | null, middleName: string | null, latinName: string | null
  phone: string | null, email: string | null, workContacts: Record<string, string>, birthDate: string | null, gender: string | null
  status: string, isBlocked: boolean, isHidden: boolean, tags: string[], cityId: string | null, hiredAt: string | null, positionSince: string | null
  externalId: string | null, comment: string | null, locale: string | null, lastSeenAt: string | null, createdAt: string, telegramChatId: string | null
  hasPassword: boolean, mustChangePassword: boolean, passwordChangedAt: string | null
  placements: { id: string, isPrimary: boolean, startedAt: string, endedAt: string | null, locationName: string, positionName: string, locationId: string, positionId: string }[]
  roles: { id: string, code: string, name: string, scopeType: string, scopeId: string | null, validUntil: string | null, reason: string | null, isOrgDerived: boolean, createdAt: string }[]
  sessions: { id: string, createdAt: string, updatedAt?: string, userAgent: string | null, ip: string | null, revokedAt: string | null }[]
}
interface Ref { id: string, name: string }
// Вкладки мокапа PersonCard: Профіль · Ролі · Навчання · Безпека · Журнал (+ Атестації и Нотатки из docs/16 §5.2,
// Документи и Відсутності — docs/v2/38 §5.1). Нотатки, документы и отсутствия видны только носителям
// своих скоупов (docs/v2/38 §2); область (своя точка) проверяет сервер
type Tab = 'profile' | 'roles' | 'learning' | 'assessment' | 'security' | 'activity' | 'notes' | 'documents' | 'absences'
const TABS: Tab[] = ['profile', 'roles', 'learning', 'assessment', 'security', 'activity', 'notes', 'documents', 'absences']
const visibleTabs = computed(() => TABS.filter(tb => tb === 'notes'
  ? hasScope('person.note.read')
  : tb === 'documents'
    ? hasScope('person.document.view_others') || hasScope('person.document.manage')
    : tb === 'absences' ? hasScope('person.absence.manage') : true))

const person = ref<Person | null>(null)
const error = ref('')
const notice = ref('')
const inviteUrl = ref('')
const busy = ref(false)
const tab = ref<Tab>((TABS as string[]).includes(String(route.query.tab)) ? route.query.tab as Tab : 'profile')
const editing = ref(route.query.edit === '1')
watch(tab, v => router.replace({ query: { ...route.query, tab: v, edit: undefined } }))

const refsData = reactive<{ locations: Ref[], positions: Ref[], levels: Ref[], units: { id: string, name: string }[], roles: { code: string, name: string }[] }>({ locations: [], positions: [], levels: [], units: [], roles: [] })
const placementForm = reactive({ locationId: '', positionId: '', positionLevelId: '' })
const roleForm = reactive({ roleCode: '', scopeType: 'location' as 'tenant' | 'location' | 'org_unit', scopeId: '', validUntil: '', reason: '' })
// Снятие роли — с причиной в аудит (docs/16 §6.2): маленькая строка подтверждения под ролью
const revoking = reactive({ code: '', reason: '' })
const roleExpired = (r: { validUntil: string | null }) => !!r.validUntil && new Date(r.validUntil).getTime() < Date.now()
function editRole(r: Person['roles'][number]) {
  Object.assign(roleForm, { roleCode: r.code, scopeType: r.scopeType, scopeId: r.scopeId ?? '', validUntil: r.validUntil ? r.validUntil.slice(0, 10) : '', reason: r.reason ?? '' })
}

const learning = ref<{ enrollments: Record<string, unknown>[], attempts: Record<string, unknown>[], certificates: Record<string, unknown>[], assessments: Record<string, unknown>[], displayAs: 'label' | 'value', currentRating: number } | null>(null)
const activity = ref<Record<string, unknown>[]>([])
const chiefs = ref<Record<string, unknown>[]>([])
// Безпека (мокап PersonCard): последний вход, активные сессии, Telegram, пароль (docs/16 §14.5 — отдельно от должности)
const securityEvents = ref<Record<string, unknown>[]>([])
const pwdForm = reactive({ open: false, password: '', repeat: '', mustChange: true })
const activeSessions = computed(() => person.value?.sessions.filter(s => !s.revokedAt).length ?? 0)
const daysInCompany = computed(() => person.value?.hiredAt ? Math.max(0, Math.floor((Date.now() - new Date(person.value.hiredAt).getTime()) / 86_400_000)) : null)
const learningSummary = computed(() => {
  const e = learning.value?.enrollments ?? []
  return { assigned: e.length, done: e.filter(x => x.status === 'done').length, overdue: e.filter(x => x.status !== 'done' && x.due_at && new Date(String(x.due_at)) < new Date()).length }
})
const eventLabel = (code: unknown) => { const key = `journals.eventText.${String(code).replace(/\./g, '_')}`; return te(key) ? t(key) : String(code) }

async function load() {
  try { person.value = await api<Person>(`/people/${id}`) }
  catch (err) { error.value = apiErrorOf(err).message }
}
async function loadRefs() {
  try {
    const [locs, poss, levels, rols, tree] = await Promise.all([
      api<Ref[]>('/refs/locations'), api<Ref[]>('/refs/positions'), api<Ref[]>('/refs/position-levels'), api<{ code: string, name: string }[]>('/settings/roles'), api<{ units: { id: string, name: string, children: unknown[] }[] }>('/org/tree'),
    ])
    const units: { id: string, name: string }[] = []
    const walk = (u: { id: string, name: string, children: unknown[] }[], d: number) => { for (const x of u) { units.push({ id: x.id, name: `${'· '.repeat(d)}${x.name}` }); walk(x.children as never, d + 1) } }
    walk(tree.units, 0)
    Object.assign(refsData, { locations: locs, positions: poss, levels, roles: rols, units })
  }
  catch { /* формы просто останутся пустыми */ }
}
async function loadTab(v: Tab) {
  try {
    if (v === 'learning' || v === 'assessment') learning.value ??= await api(`/people/${id}/learning`)
    if (v === 'activity') activity.value = await api(`/people/${id}/activity`)
    if (v === 'profile') { chiefs.value = await api('/functional-chiefs', { query: { userId: id } }); learning.value ??= await api<NonNullable<typeof learning.value>>(`/people/${id}/learning`).catch(() => null) }
    if (v === 'security' && hasScope('audit.view')) securityEvents.value = (await api<{ rows: Record<string, unknown>[] }>('/logs/security', { query: { userId: id, limit: 20 } })).rows
  }
  catch (err) { error.value = apiErrorOf(err).message }
}
watch(tab, loadTab, { immediate: true })
onMounted(() => { load(); loadRefs() })

async function act(fn: () => Promise<unknown>, doneMsg: string) {
  error.value = ''
  notice.value = ''
  busy.value = true
  try { await fn(); notice.value = doneMsg; await load() }
  catch (err) { error.value = apiErrorOf(err).message }
  finally { busy.value = false }
}

const invite = () => act(async () => {
  const res = await api<{ url: string }>(`/people/${id}/invite`, { method: 'POST' })
  inviteUrl.value = `${location.origin}${res.url}`
}, t('person.inviteCreated'))
const saveProfile = (payload: Record<string, unknown>) => act(async () => { await api(`/people/${id}`, { method: 'PATCH', body: payload }); editing.value = false }, t('common.saved'))
const block = () => act(() => api(`/people/${id}/${person.value!.isBlocked ? 'unblock' : 'block'}`, { method: 'POST' }), t('common.saved'))
const activate = () => act(() => api(`/people/${id}`, { method: 'PATCH', body: { status: 'active' } }), t('common.saved'))
const closeAll = () => act(() => api(`/people/${id}/sessions`, { method: 'DELETE' }), t('person.sessionsClosed'))
const closeOne = (sid: string) => act(() => api(`/people/${id}/sessions/${sid}`, { method: 'DELETE' }), t('person.sessionsClosed'))
const resetTelegram = () => act(() => api(`/people/${id}/reset-telegram`, { method: 'POST' }), t('person.telegramReset'))
const setPassword = () => act(async () => {
  await api(`/people/${id}/password`, { method: 'POST', body: { password: pwdForm.password, mustChange: pwdForm.mustChange } })
  Object.assign(pwdForm, { open: false, password: '', repeat: '' })
}, t('person.passwordSet'))
const addPlacementAction = () => act(() => api(`/people/${id}/placements`, { method: 'POST', body: { ...placementForm, positionLevelId: placementForm.positionLevelId || null, isPrimary: true } }), t('common.saved'))
const assignRoleAction = () => act(async () => {
  await api(`/people/${id}/roles`, { method: 'POST', body: { roleCode: roleForm.roleCode, scopeType: roleForm.scopeType, scopeId: roleForm.scopeType === 'tenant' ? null : roleForm.scopeId || null, validUntil: roleForm.validUntil || null, reason: roleForm.reason || null } })
  Object.assign(roleForm, { roleCode: '', validUntil: '', reason: '' })
}, t('common.saved'))
const removeRoleAction = (code: string) => act(async () => {
  await api(`/people/${id}/roles/${code}`, { method: 'DELETE', query: revoking.reason ? { reason: revoking.reason } : {} })
  Object.assign(revoking, { code: '', reason: '' })
}, t('common.saved'))

const showArchive = ref(false)
const archiveForm = reactive({ reason: 'dismissal', comment: '', date: '', closeSessions: true, cancelLearning: true })
const archiveConfirm = () => act(async () => {
  const r = await api<{ cancelled: number }>(`/people/${id}/archive`, { method: 'POST', body: { ...archiveForm, date: archiveForm.date || undefined } })
  showArchive.value = false
  notice.value = t('person.archived', { n: r.cancelled })
}, notice.value)

const mergeId = ref('')
const merge = () => act(async () => { await api('/people/merge', { method: 'POST', body: { primaryId: id, duplicateId: mergeId.value.trim() } }); mergeId.value = '' }, t('person.merged'))
const gdprReason = ref('')
const gdpr = () => { if (confirm(t('person.gdprConfirm'))) act(() => api('/people/gdpr-erase', { method: 'POST', body: { userId: id, reason: gdprReason.value } }), t('person.gdprDone')) }

const fmt = (d: unknown) => d ? formatShortDate(new Date(String(d))) : '—'
const fmtT = (d: unknown) => d ? formatDateTime(new Date(String(d))) : '—'
const primary = computed(() => person.value?.placements.find(p => p.isPrimary && !p.endedAt) ?? person.value?.placements[0])
</script>

<template>
  <div v-if="person">
    <NuxtLink to="/admin/people" class="back">← {{ t('admin.nav.people') }}</NuxtLink>
    <header class="head">
      <div class="avatar" aria-hidden="true">{{ person.fullName.slice(0, 1) }}</div>
      <div class="title">
        <h1>{{ person.fullName }}</h1>
        <p class="sub">{{ primary?.positionName || '—' }} · {{ primary?.locationName || '—' }}<template v-if="daysInCompany !== null"> · {{ t('person.daysInCompany', { n: daysInCompany }) }}</template></p>
        <p v-if="person.tags.length" class="tags"><span v-for="tg in person.tags" :key="tg" class="tagchip">{{ tg }}</span></p>
      </div>
      <span :class="['badge', person.status]">{{ t(`people.status.${person.status}`) }}</span>
      <span v-if="person.isHidden" class="badge">{{ t('people.hiddenBadge') }}</span>
    </header>

    <div class="actions">
      <button v-if="hasScope('people.edit')" class="btn" @click="tab = 'profile'; editing = !editing">{{ t('common.edit') }}</button>
      <button v-if="hasScope('people.invite')" class="btn primary" :disabled="busy" @click="invite">{{ t('person.resendCode') }}</button>
      <button v-if="hasScope('people.deactivate') && person.status !== 'archived'" class="btn" :disabled="busy" @click="block">{{ person.isBlocked ? t('person.unblock') : t('person.block') }}</button>
      <button v-if="hasScope('people.deactivate') && person.status === 'archived'" class="btn primary" :disabled="busy" @click="activate">{{ t('person.activate') }}</button>
      <button v-if="hasScope('people.edit')" class="btn" :disabled="busy" @click="closeAll">{{ t('person.closeSessions') }}</button>
      <button v-if="hasScope('people.edit') && person.telegramChatId" class="btn" :disabled="busy" @click="resetTelegram">{{ t('person.resetTelegram') }}</button>
      <button v-if="hasScope('people.deactivate') && person.status !== 'archived'" class="btn danger" @click="showArchive = true">{{ t('person.archive') }}</button>
    </div>

    <p v-if="error" class="error" role="alert">{{ error }}</p>
    <p v-if="notice" class="notice" role="status">{{ notice }}</p>
    <p v-if="inviteUrl" class="invite-url">{{ t('person.inviteLink') }}: <code>{{ inviteUrl }}</code></p>

    <div class="tabs" role="tablist">
      <button v-for="tb in visibleTabs" :key="tb" role="tab" :aria-selected="tab === tb" :class="['tab', { on: tab === tb }]" @click="tab = tb">{{ t(`person.tabs.${tb}`) }}</button>
    </div>

    <!-- Профіль -->
    <section v-if="tab === 'profile'" class="panel">
      <PersonForm v-if="editing" mode="edit" :initial="person" :busy="busy" @submit="saveProfile" @cancel="editing = false" />
      <div v-else class="grid">
        <div class="card">
          <h2>{{ t('person.profile') }}</h2>
          <dl>
            <dt>{{ t('person.phone') }}</dt><dd>{{ person.phone || '—' }}</dd>
            <dt>{{ t('person.email') }}</dt><dd>{{ person.email || '—' }}</dd>
            <dt>{{ t('person.latinName') }}</dt><dd>{{ person.latinName || '—' }}</dd>
            <dt>{{ t('person.birthDate') }}</dt><dd>{{ person.birthDate || '—' }}</dd>
            <dt>{{ t('person.gender') }}</dt><dd>{{ person.gender ? t(`person.genders.${person.gender}`) : '—' }}</dd>
            <dt>{{ t('person.workContacts') }}</dt><dd>{{ Object.values(person.workContacts || {}).join(' · ') || '—' }}</dd>
            <dt>{{ t('person.hiredAt') }}</dt><dd>{{ person.hiredAt || '—' }}</dd>
            <dt>{{ t('person.positionSince') }}</dt><dd>{{ person.positionSince || '—' }}</dd>
            <dt>{{ t('person.externalId') }}</dt><dd>{{ person.externalId || '—' }}</dd>
            <dt>{{ t('person.tags') }}</dt><dd>{{ person.tags.join(', ') || '—' }}</dd>
            <dt>{{ t('people.col.registered') }}</dt><dd>{{ fmt(person.createdAt) }}</dd>
            <dt>{{ t('people.col.lastSeen') }}</dt><dd>{{ fmt(person.lastSeenAt) }}</dd>
            <dt v-if="person.comment">{{ t('person.comment') }}</dt><dd v-if="person.comment">{{ person.comment }}</dd>
          </dl>
        </div>

        <div class="card">
          <h2>{{ t('person.placementHistory') }}</h2>
          <ul class="list">
            <li v-for="p in person.placements" :key="p.id" :class="{ ended: p.endedAt }">
              <b>{{ p.positionName }}</b> · {{ p.locationName }}
              <span class="sub">{{ p.startedAt }}{{ p.endedAt ? ` — ${p.endedAt}` : '' }}</span>
            </li>
            <li v-if="person.placements.length === 0" class="sub">—</li>
          </ul>
          <div v-if="hasScope('people.edit')" class="form-row">
            <select v-model="placementForm.locationId" :aria-label="t('person.location')"><option value="" disabled>{{ t('person.location') }}</option><option v-for="l in refsData.locations" :key="l.id" :value="l.id">{{ l.name }}</option></select>
            <select v-model="placementForm.positionId" :aria-label="t('person.position')"><option value="" disabled>{{ t('person.position') }}</option><option v-for="p in refsData.positions" :key="p.id" :value="p.id">{{ p.name }}</option></select>
            <select v-model="placementForm.positionLevelId" :aria-label="t('person.level')"><option value="">{{ t('person.level') }}</option><option v-for="p in refsData.levels" :key="p.id" :value="p.id">{{ p.name }}</option></select>
            <button class="btn primary" :disabled="!placementForm.locationId || !placementForm.positionId || busy" @click="addPlacementAction">{{ t('person.addPlacement') }}</button>
          </div>
          <h2 class="mt">{{ t('person.chiefs') }}</h2>
          <ul class="list">
            <li v-for="c in chiefs" :key="String(c.id)"><b>{{ c.user_id === id ? c.chief_name : c.user_name }}</b> <span class="sub">{{ t(`orgAdmin.${c.kind}`) }}{{ c.scope ? ` · ${c.scope}` : '' }}{{ c.user_id === id ? '' : ` · ${t('orgAdmin.subordinate')}` }}</span></li>
            <li v-if="chiefs.length === 0" class="sub">—</li>
          </ul>
        </div>

        <div class="card summary">
          <h2>{{ t('person.tabs.learning') }}</h2>
          <dl class="stats">
            <div><dt>{{ t('person.assigned') }}</dt><dd>{{ learningSummary.assigned }}</dd></div>
            <div><dt>{{ t('person.doneCount') }}</dt><dd class="teal">{{ learningSummary.done }}</dd></div>
            <div><dt>{{ t('person.overdueCount') }}</dt><dd :class="{ coral: learningSummary.overdue > 0 }">{{ learningSummary.overdue }}</dd></div>
            <div><dt>{{ t('person.certificates') }}</dt><dd>{{ learning?.certificates.length ?? 0 }}</dd></div>
            <div><dt>{{ t('person.rating') }}</dt><dd>{{ learning?.currentRating ?? 0 }}</dd></div>
          </dl>
        </div>

        <!-- Мокап PersonCard: зведення «Ролі» — підпис про автопризначення, чипи ролей, «Змінити ролі» -->
        <div class="card summary">
          <h2>{{ t('person.tabs.roles') }}</h2>
          <p v-if="person.roles.some(r => r.isOrgDerived)" class="sub">{{ t('person.roleDerived') }}</p>
          <p v-if="person.roles.length" class="tags"><span v-for="r in person.roles" :key="r.id" class="tagchip">{{ r.name }}</span></p>
          <p v-else class="sub">—</p>
          <button class="btn small" @click="tab = 'roles'">{{ t('person.changeRoles') }}</button>
        </div>

        <div class="card summary">
          <h2>{{ t('person.tabs.security') }}</h2>
          <dl>
            <dt>{{ t('person.lastLogin') }}</dt><dd>{{ fmtT(person.lastSeenAt) }}</dd>
            <dt>{{ t('person.activeSessions') }}</dt><dd>{{ activeSessions }}</dd>
            <dt>Telegram</dt><dd>{{ person.telegramChatId ? t('person.telegramLinked') : '—' }}</dd>
            <dt>{{ t('person.password') }}</dt><dd>{{ person.hasPassword ? (person.mustChangePassword ? t('person.passwordMustChange') : t('person.passwordSetShort')) : t('person.passwordNone') }}</dd>
          </dl>
          <button class="btn small" @click="tab = 'security'">{{ t('person.resetPassword') }}</button>
        </div>

        <div v-if="hasScope('people.deactivate')" class="card">
          <h2>{{ t('person.merge') }}</h2>
          <p class="sub">{{ t('person.mergeHint') }}</p>
          <div class="form-row">
            <input v-model="mergeId" :placeholder="'UUID'" :aria-label="t('person.merge')">
            <button class="btn" :disabled="!mergeId || busy" @click="merge">{{ t('person.merge') }}</button>
          </div>
          <template v-if="hasScope('settings.tenant')">
            <h2 class="mt">{{ t('person.gdpr') }}</h2>
            <div class="form-row">
              <input v-model="gdprReason" :placeholder="t('person.gdprReason')" :aria-label="t('person.gdprReason')">
              <button class="btn danger" :disabled="gdprReason.length < 3 || busy" @click="gdpr">{{ t('person.gdpr') }}</button>
            </div>
          </template>
        </div>
      </div>
    </section>

    <!-- Ролі (мокап PersonCard: список ролей, у производной — подпись «Видана автоматично…», срок и причина — docs/16 §6.2) -->
    <section v-else-if="tab === 'roles'" class="panel card">
      <ul class="list">
        <li v-for="r in person.roles" :key="r.id" class="role-row">
          <div class="role-main">
            <b>{{ r.name }}</b>
            <span class="sub">{{ r.scopeType === 'tenant' ? t('person.wholeTenant') : r.scopeType === 'location' ? (refsData.locations.find(l => l.id === r.scopeId)?.name ?? t('person.location')) : t('person.orgUnitScope') }}</span>
            <span :class="['badge', roleExpired(r) ? 'coral' : r.validUntil ? 'sun' : 'muted']">{{ roleExpired(r) ? t('person.validExpired') : r.validUntil ? `${t('person.validUntil')} ${fmt(r.validUntil)}` : t('person.validForever') }}</span>
            <span v-if="r.isOrgDerived" class="badge teal">{{ t('person.roleDerived') }}</span>
            <small class="sub">{{ t('person.roleSince', { date: fmt(r.createdAt) }) }}<template v-if="r.reason && !r.isOrgDerived"> · {{ r.reason }}</template></small>
          </div>
          <div v-if="hasScope('role.assign')" class="role-actions">
            <button class="btn small" :disabled="busy" @click="editRole(r)">{{ t('person.editRole') }}</button>
            <button v-if="revoking.code !== r.code" class="btn small" :disabled="busy" @click="Object.assign(revoking, { code: r.code, reason: '' })">{{ t('person.removeRole') }}</button>
          </div>
          <form v-if="revoking.code === r.code" class="revoke" @submit.prevent="removeRoleAction(r.code)">
            <input v-model="revoking.reason" type="text" maxlength="500" :placeholder="t('person.revokeReason')" :aria-label="t('person.revokeReason')">
            <button type="submit" class="btn small primary" :disabled="busy">{{ t('person.confirmRevoke') }}</button>
            <button type="button" class="btn small" @click="revoking.code = ''">{{ t('common.cancel') }}</button>
          </form>
        </li>
        <li v-if="person.roles.length === 0" class="sub">—</li>
      </ul>
      <form v-if="hasScope('role.assign')" class="form-row" @submit.prevent="assignRoleAction">
        <select v-model="roleForm.roleCode" :aria-label="t('person.role')"><option value="" disabled>{{ t('person.role') }}</option><option v-for="r in refsData.roles" :key="r.code" :value="r.code">{{ r.name }}</option></select>
        <select v-model="roleForm.scopeType" :aria-label="t('person.scope')">
          <option value="location">{{ t('person.location') }}</option>
          <option value="org_unit">{{ t('person.orgUnitScope') }}</option>
          <option value="tenant">{{ t('person.wholeTenant') }}</option>
        </select>
        <select v-if="roleForm.scopeType === 'location'" v-model="roleForm.scopeId" :aria-label="t('person.location')"><option value="" disabled>{{ t('person.location') }}</option><option v-for="l in refsData.locations" :key="l.id" :value="l.id">{{ l.name }}</option></select>
        <select v-if="roleForm.scopeType === 'org_unit'" v-model="roleForm.scopeId" :aria-label="t('person.orgUnitScope')"><option value="" disabled>{{ t('person.orgUnitScope') }}</option><option v-for="u in refsData.units" :key="u.id" :value="u.id">{{ u.name }}</option></select>
        <label class="field"><span>{{ t('person.validUntil') }}</span><input v-model="roleForm.validUntil" type="date"></label>
        <label class="field grow"><span>{{ t('person.reason') }}</span><input v-model="roleForm.reason" type="text" maxlength="500" :placeholder="t('person.reasonHint')"></label>
        <button type="submit" class="btn primary" :disabled="!roleForm.roleCode || busy">{{ t('person.addRole') }}</button>
      </form>
    </section>

    <!-- Навчання -->
    <section v-else-if="tab === 'learning'" class="panel">
      <div class="card">
        <h2>{{ t('person.enrollments') }}</h2>
        <table v-if="learning?.enrollments.length" class="table"><thead><tr><th>{{ t('people.col.name') }}</th><th>{{ t('assign.col.status') }}</th><th>%</th><th>{{ t('dev.due') }}</th></tr></thead>
          <tbody><tr v-for="e in learning.enrollments" :key="String(e.id)"><td>{{ e.title }} <span class="sub">{{ e.subject_type }}</span></td><td><span :class="['badge', String(e.status)]">{{ e.status }}</span></td><td>{{ e.progress_pct }}</td><td class="sub">{{ fmt(e.due_at) }}<span v-if="e.deadline_shifted_reason === 'absence'" class="badge shifted">{{ t('person.deadlineShifted') }}</span></td></tr></tbody></table>
        <p v-else class="sub">{{ t('person.noData') }}</p>
      </div>
      <div class="card">
        <h2>{{ t('person.certificates') }}</h2>
        <ul v-if="learning?.certificates.length" class="list">
          <li v-for="c in learning.certificates" :key="String(c.id)"><b>{{ c.title || c.number }}</b> <span class="sub">{{ c.number }} · {{ c.score }}% · {{ fmt(c.issued_at) }}{{ c.valid_until ? ` → ${fmt(c.valid_until)}` : '' }}{{ c.revoked_at ? ` · ${t('person.revoked')}` : '' }}</span> <a :href="`/c/${c.public_token}`" target="_blank" rel="noopener" class="link">↗</a></li>
        </ul>
        <p v-else class="sub">{{ t('person.noData') }}</p>
      </div>
    </section>

    <!-- Атестації -->
    <section v-else-if="tab === 'assessment'" class="panel">
      <div class="card">
        <h2>{{ t('person.attempts') }}</h2>
        <table v-if="learning?.attempts.length" class="table"><thead><tr><th>{{ t('people.col.name') }}</th><th>#</th><th>{{ t('assign.col.status') }}</th><th>%</th><th>{{ t('people.col.registered') }}</th></tr></thead>
          <tbody><tr v-for="a in learning.attempts" :key="String(a.id)"><td>{{ a.title }}</td><td>{{ a.attempt_no }}</td><td>{{ a.status }}{{ a.passed === true ? ' ✓' : a.passed === false ? ' ✕' : '' }}</td><td>{{ a.max_score ? Math.round(Number(a.score) / Number(a.max_score) * 100) : '—' }}</td><td class="sub">{{ fmtT(a.submitted_at ?? a.started_at) }}</td></tr></tbody></table>
        <p v-else class="sub">{{ t('person.noData') }}</p>
      </div>
      <div class="card">
        <h2>{{ t('person.competencies') }}</h2>
        <ul v-if="learning?.assessments.length" class="list">
          <li v-for="a in learning.assessments" :key="String(a.id)"><b>{{ a.competency }}</b> — {{ learning?.displayAs === 'label' ? a.levelLabel : a.level }} <span class="sub">{{ a.source }} · {{ fmt(a.assessed_at) }}</span></li>
        </ul>
        <p v-else class="sub">{{ t('person.noData') }}</p>
      </div>
    </section>

    <!-- Безпека (мокап PersonCard: останній вхід · сесій активних · Telegram · «Скинути пароль»; docs/16 §14.5) -->
    <section v-else-if="tab === 'security'" class="panel">
      <div class="grid">
        <div class="card">
          <h2>{{ t('person.tabs.security') }}</h2>
          <dl>
            <dt>{{ t('person.lastLogin') }}</dt><dd>{{ fmtT(person.lastSeenAt) }}</dd>
            <dt>{{ t('person.activeSessions') }}</dt><dd>{{ activeSessions }}</dd>
            <dt>Telegram</dt><dd>{{ person.telegramChatId ? t('person.telegramLinked') : '—' }}</dd>
            <dt>{{ t('person.password') }}</dt><dd>{{ person.hasPassword ? `${t('person.passwordSetShort')} · ${fmt(person.passwordChangedAt)}` : t('person.passwordNone') }}<span v-if="person.mustChangePassword" class="badge sun">{{ t('person.passwordMustChange') }}</span></dd>
          </dl>
          <div class="form-row">
            <button v-if="hasScope('people.password')" class="btn" :aria-expanded="pwdForm.open" @click="pwdForm.open = !pwdForm.open">{{ person.hasPassword ? t('person.resetPassword') : t('person.setPassword') }}</button>
            <button v-if="hasScope('people.edit') && person.telegramChatId" class="btn" :disabled="busy" @click="resetTelegram">{{ t('person.resetTelegram') }}</button>
            <button v-if="hasScope('people.edit')" class="btn" :disabled="busy" @click="closeAll">{{ t('person.closeSessions') }}</button>
          </div>
          <form v-if="pwdForm.open" class="pwd" @submit.prevent="setPassword">
            <p class="sub">{{ t('person.passwordHint') }}</p>
            <label class="field"><span>{{ t('person.newPassword') }}</span><input v-model="pwdForm.password" type="password" minlength="8" maxlength="200" autocomplete="new-password" required></label>
            <label class="field"><span>{{ t('person.repeatPassword') }}</span><input v-model="pwdForm.repeat" type="password" minlength="8" maxlength="200" autocomplete="new-password" required></label>
            <label class="check"><input v-model="pwdForm.mustChange" type="checkbox"> {{ t('person.mustChangeAfterLogin') }}</label>
            <p v-if="pwdForm.repeat && pwdForm.repeat !== pwdForm.password" class="error">{{ t('person.passwordsDiffer') }}</p>
            <div class="form-row">
              <button type="submit" class="btn primary" :disabled="busy || pwdForm.password.length < 8 || pwdForm.password !== pwdForm.repeat">{{ t('common.save') }}</button>
              <button type="button" class="btn" @click="pwdForm.open = false">{{ t('common.cancel') }}</button>
            </div>
          </form>
        </div>
        <div class="card">
          <h2>{{ t('person.sessions') }}</h2>
          <table v-if="person.sessions.length" class="table"><thead><tr><th>{{ t('person.device') }}</th><th>{{ t('person.ip') }}</th><th>{{ t('person.signedIn') }}</th><th /></tr></thead>
            <tbody><tr v-for="s in person.sessions" :key="s.id" :class="{ ended: s.revokedAt }"><td class="ua">{{ s.userAgent || '—' }}</td><td class="sub">{{ s.ip || '—' }}</td><td class="sub">{{ fmtT(s.createdAt) }}</td><td><button v-if="!s.revokedAt && hasScope('people.edit')" class="btn small" :disabled="busy" @click="closeOne(s.id)">{{ t('person.closeSession') }}</button><span v-else-if="s.revokedAt" class="sub">{{ t('person.revoked') }}</span></td></tr></tbody></table>
          <p v-else class="sub">{{ t('person.noData') }}</p>
        </div>
        <div v-if="hasScope('audit.view')" class="card">
          <h2>{{ t('journals.title.security') }}</h2>
          <ul v-if="securityEvents.length" class="list">
            <li v-for="e in securityEvents" :key="String(e.id)"><span :class="['badge', String(e.severity) === 'critical' ? 'coral' : String(e.severity) === 'warning' ? 'sun' : 'muted']">{{ t(`journals.severity.${e.severity}`) }}</span> {{ eventLabel(e.event) }} <span class="sub">{{ fmtT(String(e.created_at).replace(' ', 'T')) }}{{ e.ip ? ` · ${e.ip}` : '' }}</span></li>
          </ul>
          <p v-else class="sub">{{ t('person.noData') }}</p>
          <NuxtLink to="/admin/journals?tab=security" class="link">{{ t('journals.title.security') }} →</NuxtLink>
        </div>
      </div>
    </section>

    <!-- Журнал (мокап PersonCard: «Журнал»; сессии — на вкладке «Безпека») -->
    <section v-else-if="tab === 'activity'" class="panel">
      <div class="card">
        <h2>{{ t('person.log') }}</h2>
        <ul v-if="activity.length" class="list">
          <li v-for="a in activity" :key="String(a.id)"><code>{{ a.action }}</code> <span class="sub">{{ a.entity }} · {{ fmtT(a.created_at) }}{{ a.ip ? ` · ${a.ip}` : '' }}</span></li>
        </ul>
        <p v-else class="sub">{{ t('person.noData') }}</p>
      </div>
    </section>

    <!-- Нотатки (docs/v2/38 §5.1): открыть вкладку и значит развернуть секцию — чтение пишется в журнал -->
    <section v-else-if="tab === 'notes' && visibleTabs.includes('notes')" class="panel">
      <PersonNotes :person-id="id" auto-open />
    </section>

    <!-- Документи (docs/v2/38 §5.1, §6.2) -->
    <section v-else-if="tab === 'documents' && visibleTabs.includes('documents')" class="panel">
      <PersonDocuments :person-id="id" auto-open />
    </section>

    <!-- Відсутності (docs/v2/38 §5.1, §6.3, §6.4): норма, остаток, записи, «Скоригувати» -->
    <section v-else-if="tab === 'absences' && visibleTabs.includes('absences')" class="panel">
      <PersonAbsences :person-id="id" auto-open />
    </section>

    <div v-if="showArchive" class="overlay" @click.self="showArchive = false">
      <form class="modal" role="dialog" aria-modal="true" @submit.prevent="archiveConfirm">
        <h2>{{ t('person.archiveTitle') }}</h2>
        <label>{{ t('person.archiveReason') }}<select v-model="archiveForm.reason"><option v-for="r in ['dismissal', 'transfer', 'mistake', 'other']" :key="r" :value="r">{{ t(`person.reasons.${r}`) }}</option></select></label>
        <label>{{ t('person.archiveDate') }}<input v-model="archiveForm.date" type="date"></label>
        <label>{{ t('person.comment') }}<input v-model="archiveForm.comment" maxlength="500"></label>
        <label class="check"><input v-model="archiveForm.closeSessions" type="checkbox"> {{ t('person.archiveClose') }}</label>
        <label class="check"><input v-model="archiveForm.cancelLearning" type="checkbox"> {{ t('person.archiveCancel') }}</label>
        <div class="modal-actions">
          <button type="button" class="btn" @click="showArchive = false">{{ t('common.cancel') }}</button>
          <button type="submit" class="btn danger" :disabled="busy">{{ t('person.archive') }}</button>
        </div>
      </form>
    </div>
  </div>
  <p v-else-if="error" class="error">{{ error }}</p>
</template>

<style scoped>
.back { color: var(--color-ink-muted); text-decoration: none; font-size: var(--font-size-body-s); }
.head { display: flex; align-items: center; gap: var(--space-3); margin: var(--space-2) 0 var(--space-3); flex-wrap: wrap; }
.avatar { width: 48px; height: 48px; border-radius: 50%; background: var(--color-sun); color: var(--color-ink); display: grid; place-items: center; font-weight: 900; font-size: var(--font-size-title-l); }
.title { min-width: 0; }
h1 { margin: 0; font-weight: 900; }
h2 { margin: 0 0 var(--space-2); font-size: var(--font-size-body); color: var(--color-ink-muted); }
h2.mt { margin-top: var(--space-4); }
.actions { display: flex; gap: var(--space-2); flex-wrap: wrap; margin-bottom: var(--space-3); }
.tabs { display: flex; gap: var(--space-2); margin-bottom: var(--space-3); flex-wrap: wrap; }
.tab { font: inherit; font-weight: 700; border: 1px solid var(--color-bg-line); background: transparent; color: var(--color-ink-muted); border-radius: var(--radius-pill); padding: var(--space-1) var(--space-4); cursor: pointer; }
.tab.on { background: var(--color-ink); border-color: var(--color-ink); color: var(--color-bg-soft); }
.panel { display: grid; gap: var(--space-3); }
.grid { display: grid; grid-template-columns: repeat(auto-fit, minmax(280px, 1fr)); gap: var(--space-3); }
.card { background: var(--color-bg-soft); border-radius: var(--radius-m); padding: var(--space-4); min-width: 0; }
dl { display: grid; grid-template-columns: auto 1fr; gap: var(--space-1) var(--space-4); margin: 0; }
dt { color: var(--color-ink-faint); font-size: var(--font-size-body-s); }
dd { margin: 0; overflow-wrap: anywhere; }
.list { list-style: none; margin: 0 0 var(--space-3); padding: 0; display: grid; gap: var(--space-2); }
.role-row { display: grid; gap: var(--space-2); }
.role-main { display: flex; gap: var(--space-2); align-items: center; flex-wrap: wrap; }
.role-actions { display: flex; gap: var(--space-2); flex-wrap: wrap; }
.revoke { display: flex; gap: var(--space-2); flex-wrap: wrap; align-items: center; }
.revoke input { flex: 1 1 160px; min-width: 0; }
.field { display: grid; gap: 2px; font-size: 12px; font-weight: 700; color: var(--color-ink-muted); }
.field.grow { flex: 1 1 200px; min-width: 0; }
.ended { opacity: 0.5; }
.sub { color: var(--color-ink-faint); font-size: var(--font-size-body-s); }
.tags { margin: var(--space-1) 0 0; display: flex; gap: var(--space-1); flex-wrap: wrap; }
.tagchip { background: var(--color-sun); border-radius: var(--radius-pill); padding: 0 var(--space-2); font-size: var(--font-size-body-s); font-weight: 800; }
.stats { display: grid; grid-template-columns: repeat(auto-fit, minmax(90px, 1fr)); gap: var(--space-2); margin-bottom: var(--space-3); }
.stats div { display: grid; gap: 2px; }
.stats dd { font-size: var(--font-size-title-l); font-weight: 900; }
.stats dd.teal { color: var(--color-teal-ink); }
.stats dd.coral { color: var(--color-coral-ink); }
.pwd { display: grid; gap: var(--space-2); margin-top: var(--space-3); max-width: 360px; }
.check { display: flex; align-items: center; gap: var(--space-2); font-size: var(--font-size-body-s); }
.badge.sun { background: var(--color-sun); color: var(--color-sun-ink); margin-left: var(--space-2); }
.badge.coral { background: var(--color-coral); color: var(--color-coral-deep); }
.badge.muted { background: var(--color-bg-line-soft); color: var(--color-ink-muted); }
/* Срок сдвинут с дней отсутствия (docs/v2/38 §7.14): справка рядом с датой, не тревога */
.badge.shifted { display: block; width: fit-content; margin-top: var(--space-1); color: var(--color-ink-muted); }
.form-row { display: flex; gap: var(--space-2); flex-wrap: wrap; align-items: flex-start; }
select, input, textarea { font: inherit; border: 1px solid var(--color-bg-line); border-radius: var(--radius-s); padding: var(--space-1) var(--space-2); background: var(--color-bg); color: var(--color-ink); max-width: 100%; min-width: 0; box-sizing: border-box; }
textarea { flex: 1; min-width: 200px; }
.btn { font: inherit; font-weight: 700; border: 1px solid var(--color-bg-line); background: var(--color-bg-soft); color: var(--color-ink); border-radius: var(--radius-pill); padding: var(--space-1) var(--space-4); cursor: pointer; }
.btn.primary { background: var(--color-sun); border-color: var(--color-sun); }
.btn.danger { background: var(--color-coral); border-color: var(--color-coral); color: var(--color-coral-deep); }
.btn.small { font-size: var(--font-size-body-s); padding: 0 var(--space-3); }
.btn:disabled { opacity: 0.5; }
.badge { font-size: var(--font-size-body-s); font-weight: 700; border-radius: var(--radius-pill); padding: 2px var(--space-3); background: var(--color-bg-line-soft); }
.badge.active, .badge.completed { background: var(--color-teal); color: var(--color-teal-deep); }
.badge.invited, .badge.in_progress { background: var(--color-sun); color: var(--color-sun-ink); }
.badge.suspended, .badge.archived, .badge.overdue { background: var(--color-coral); color: var(--color-coral-deep); }
.table { width: 100%; border-collapse: collapse; }
th { text-align: left; font-size: var(--font-size-body-s); color: var(--color-ink-muted); padding: var(--space-1) var(--space-2); border-bottom: 1px solid var(--color-bg-line); }
td { padding: var(--space-1) var(--space-2); border-bottom: 1px solid var(--color-bg-line-soft); vertical-align: top; }
.ua { max-width: 260px; overflow: hidden; text-overflow: ellipsis; white-space: nowrap; font-size: var(--font-size-body-s); }
.link { color: var(--color-teal-ink); text-decoration: none; font-weight: 700; }
.error { color: var(--color-coral-ink); }
.notice { color: var(--color-teal-ink); }
.invite-url { font-size: var(--font-size-body-s); word-break: break-all; }
.overlay { position: fixed; inset: 0; background: rgb(0 0 0 / 40%); display: grid; place-items: center; padding: var(--space-3); z-index: 20; }
.modal { background: var(--color-bg-soft); border-radius: var(--radius-l); padding: var(--space-4); display: grid; gap: var(--space-3); width: min(440px, 100%); box-sizing: border-box; }
.modal label { display: grid; gap: var(--space-1); font-size: var(--font-size-body-s); color: var(--color-ink-muted); }
.modal .check { display: flex; align-items: center; gap: var(--space-2); color: var(--color-ink); }
.modal-actions { display: flex; gap: var(--space-2); justify-content: flex-end; flex-wrap: wrap; }
</style>
