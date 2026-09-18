<script setup lang="ts">
definePageMeta({ layout: 'admin', middleware: 'admin-scope' })

const { t } = useI18n()
const { api } = useApi()
const { hasScope } = useAuth()
const route = useRoute()
const id = route.params.id as string

interface Person {
  id: string
  fullName: string
  phone: string | null
  email: string | null
  status: string
  tags: string[]
  hiredAt: string | null
  lastSeenAt: string | null
  placements: { id: string, isPrimary: boolean, startedAt: string, endedAt: string | null, locationName: string, positionName: string, locationId: string, positionId: string }[]
  roles: { id: string, code: string, name: string, scopeType: string, scopeId: string | null }[]
  sessions: { id: string, createdAt: string, userAgent: string | null, ip: string | null, revokedAt: string | null }[]
}

const person = ref<Person | null>(null)
const error = ref('')
const notice = ref('')
const inviteUrl = ref('')

const refsData = ref<{ locations: { id: string, name: string }[], positions: { id: string, name: string }[], roles: { code: string, name: string }[] }>({ locations: [], positions: [], roles: [] })
const placementForm = reactive({ locationId: '', positionId: '' })
const roleForm = reactive({ roleCode: '', scopeType: 'location' as 'tenant' | 'location', scopeId: '' })

async function load() {
  try {
    person.value = await api<Person>(`/people/${id}`)
  }
  catch (err) {
    error.value = apiErrorOf(err).message
  }
}

async function loadRefs() {
  try {
    const [locs, poss, rols] = await Promise.all([
      api<{ id: string, name: string }[]>('/refs/locations'),
      api<{ id: string, name: string }[]>('/refs/positions'),
      api<{ code: string, name: string }[]>('/settings/roles'),
    ])
    refsData.value = { locations: locs, positions: poss, roles: rols }
  }
  catch { /* формы просто останутся пустыми */ }
}

onMounted(() => {
  load()
  loadRefs()
})

async function act(fn: () => Promise<unknown>, doneMsg: string) {
  error.value = ''
  notice.value = ''
  try {
    await fn()
    notice.value = doneMsg
    await load()
  }
  catch (err) {
    error.value = apiErrorOf(err).message
  }
}

const invite = () => act(async () => {
  const res = await api<{ url: string }>(`/people/${id}/invite`, { method: 'POST' })
  inviteUrl.value = `${location.origin}${res.url}`
}, t('person.inviteCreated'))

const setStatus = (status: string) =>
  act(() => api(`/people/${id}`, { method: 'PATCH', body: { status } }), t('common.saved'))

const addPlacementAction = () =>
  act(() => api(`/people/${id}/placements`, { method: 'POST', body: { ...placementForm, isPrimary: true } }), t('common.saved'))

const assignRoleAction = () =>
  act(() => api(`/people/${id}/roles`, {
    method: 'POST',
    body: {
      roleCode: roleForm.roleCode,
      scopeType: roleForm.scopeType,
      scopeId: roleForm.scopeType === 'tenant' ? null : roleForm.scopeId || null,
    },
  }), t('common.saved'))
</script>

<template>
  <div v-if="person">
    <NuxtLink to="/admin/people" class="back">← {{ t('admin.nav.people') }}</NuxtLink>
    <header class="head">
      <h1>{{ person.fullName }}</h1>
      <span :class="['badge', person.status]">{{ t(`people.status.${person.status}`) }}</span>
    </header>

    <p v-if="error" class="error">{{ error }}</p>
    <p v-if="notice" class="notice">{{ notice }}</p>

    <section class="grid">
      <div class="card">
        <h2>{{ t('person.profile') }}</h2>
        <dl>
          <dt>{{ t('person.phone') }}</dt><dd>{{ person.phone || '—' }}</dd>
          <dt>Email</dt><dd>{{ person.email || '—' }}</dd>
          <dt>{{ t('person.hiredAt') }}</dt><dd>{{ person.hiredAt || '—' }}</dd>
          <dt>{{ t('person.tags') }}</dt><dd>{{ person.tags.join(', ') || '—' }}</dd>
        </dl>
        <div class="actions">
          <button v-if="hasScope('people.invite')" class="primary" @click="invite">
            {{ t('person.sendInvite') }}
          </button>
          <button
            v-if="hasScope('people.deactivate') && person.status === 'active'"
            class="danger"
            @click="setStatus('suspended')"
          >
            {{ t('person.suspend') }}
          </button>
          <button
            v-if="hasScope('people.deactivate') && person.status === 'suspended'"
            class="primary"
            @click="setStatus('active')"
          >
            {{ t('person.activate') }}
          </button>
          <button
            v-if="hasScope('people.deactivate') && person.status !== 'archived'"
            class="danger"
            @click="setStatus('archived')"
          >
            {{ t('person.archive') }}
          </button>
        </div>
        <p v-if="inviteUrl" class="invite-url">{{ t('person.inviteLink') }}: <code>{{ inviteUrl }}</code></p>
      </div>

      <div class="card">
        <h2>{{ t('person.placements') }}</h2>
        <ul class="list">
          <li v-for="p in person.placements" :key="p.id" :class="{ ended: p.endedAt }">
            <b>{{ p.positionName }}</b> · {{ p.locationName }}
            <span class="sub">{{ p.startedAt }}{{ p.endedAt ? ` — ${p.endedAt}` : '' }}</span>
          </li>
          <li v-if="person.placements.length === 0" class="sub">—</li>
        </ul>
        <div v-if="hasScope('people.edit')" class="form-row">
          <select v-model="placementForm.locationId">
            <option value="" disabled>{{ t('person.location') }}</option>
            <option v-for="l in refsData.locations" :key="l.id" :value="l.id">{{ l.name }}</option>
          </select>
          <select v-model="placementForm.positionId">
            <option value="" disabled>{{ t('person.position') }}</option>
            <option v-for="p in refsData.positions" :key="p.id" :value="p.id">{{ p.name }}</option>
          </select>
          <button class="primary" :disabled="!placementForm.locationId || !placementForm.positionId" @click="addPlacementAction">+</button>
        </div>
      </div>

      <div class="card">
        <h2>{{ t('person.roles') }}</h2>
        <ul class="list">
          <li v-for="r in person.roles" :key="r.id">
            <b>{{ r.name }}</b>
            <span class="sub">{{ r.scopeType === 'tenant' ? t('person.wholeTenant') : r.scopeType }}</span>
          </li>
          <li v-if="person.roles.length === 0" class="sub">—</li>
        </ul>
        <div v-if="hasScope('role.assign')" class="form-row">
          <select v-model="roleForm.roleCode">
            <option value="" disabled>{{ t('person.role') }}</option>
            <option v-for="r in refsData.roles" :key="r.code" :value="r.code">{{ r.name }}</option>
          </select>
          <select v-model="roleForm.scopeType">
            <option value="location">{{ t('person.location') }}</option>
            <option value="tenant">{{ t('person.wholeTenant') }}</option>
          </select>
          <select v-if="roleForm.scopeType === 'location'" v-model="roleForm.scopeId">
            <option value="" disabled>{{ t('person.location') }}</option>
            <option v-for="l in refsData.locations" :key="l.id" :value="l.id">{{ l.name }}</option>
          </select>
          <button class="primary" :disabled="!roleForm.roleCode" @click="assignRoleAction">+</button>
        </div>
      </div>

      <div class="card">
        <h2>{{ t('person.sessions') }}</h2>
        <ul class="list">
          <li v-for="s in person.sessions" :key="s.id" :class="{ ended: s.revokedAt }">
            {{ new Date(s.createdAt).toLocaleString('uk') }}
            <span class="sub">{{ s.ip || '' }} {{ s.revokedAt ? `· ${t('person.revoked')}` : '' }}</span>
          </li>
          <li v-if="person.sessions.length === 0" class="sub">—</li>
        </ul>
      </div>
    </section>
  </div>
  <p v-else-if="error" class="error">{{ error }}</p>
</template>

<style scoped>
.back {
  color: var(--color-ink-muted);
  text-decoration: none;
  font-size: var(--font-size-body-s);
}

.head {
  display: flex;
  align-items: center;
  gap: var(--space-3);
  margin: var(--space-2) 0 var(--space-4);
}

h1 {
  margin: 0;
  font-weight: 900;
}

h2 {
  margin: 0 0 var(--space-3);
  font-size: var(--font-size-body);
  color: var(--color-ink-muted);
}

.grid {
  display: grid;
  grid-template-columns: repeat(auto-fit, minmax(280px, 1fr));
  gap: var(--space-4);
}

.card {
  background: var(--color-bg-soft);
  border-radius: var(--radius-m);
  padding: var(--space-4);
}

dl {
  display: grid;
  grid-template-columns: auto 1fr;
  gap: var(--space-1) var(--space-4);
  margin: 0 0 var(--space-3);
}

dt {
  color: var(--color-ink-faint);
  font-size: var(--font-size-body-s);
}

dd {
  margin: 0;
}

.list {
  list-style: none;
  margin: 0 0 var(--space-3);
  padding: 0;
  display: grid;
  gap: var(--space-2);
}

.ended {
  opacity: 0.5;
}

.sub {
  color: var(--color-ink-faint);
  font-size: var(--font-size-body-s);
}

.actions {
  display: flex;
  gap: var(--space-2);
  flex-wrap: wrap;
}

.form-row {
  display: flex;
  gap: var(--space-2);
  flex-wrap: wrap;
}

select {
  font: inherit;
  border: 1px solid var(--color-bg-line);
  border-radius: var(--radius-s);
  padding: var(--space-1) var(--space-2);
  background: var(--color-bg);
  color: var(--color-ink);
  max-width: 160px;
}

button {
  font: inherit;
  font-weight: 700;
  border: none;
  border-radius: var(--radius-pill);
  padding: var(--space-1) var(--space-4);
  cursor: pointer;
}

button:disabled {
  opacity: 0.5;
}

.primary {
  background: var(--color-sun);
  color: var(--color-ink);
}

.danger {
  background: var(--color-coral);
  color: var(--color-coral-deep);
}

.badge {
  font-size: var(--font-size-body-s);
  font-weight: 700;
  border-radius: var(--radius-pill);
  padding: 2px var(--space-3);
  background: var(--color-bg-line-soft);
}

.badge.active { background: var(--color-teal); color: var(--color-teal-deep); }
.badge.invited { background: var(--color-sun); color: var(--color-sun-ink); }
.badge.suspended, .badge.archived { background: var(--color-coral); color: var(--color-coral-deep); }

.error { color: var(--color-coral-ink); }
.notice { color: var(--color-teal-ink); }

.invite-url {
  margin-top: var(--space-3);
  font-size: var(--font-size-body-s);
  word-break: break-all;
}
</style>
