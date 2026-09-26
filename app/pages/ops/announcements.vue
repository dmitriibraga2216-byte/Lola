<script setup lang="ts">
/**
 * Консоль оператора → «Оголошення» (docs/24 §4.7, docs/v2/39 П-21, П-24.2): друга «новина» —
 * від Lola до просторів, лише читання для тенанта. Перенесено зі старої панелі `/ops`.
 */
definePageMeta({ layout: 'ops', middleware: 'ops-auth' })
const { t } = useI18n()
const { formatShortDate } = useFormat()
const { ops, can } = useOps()

interface Announcement { id: string, title: string, body: string, audience: 'all' | 'plans' | 'tenants', planCodes: string[], tenantIds: string[], publishedAt: string | null, archivedAt: string | null, createdAt: string, readers: number }
interface Plan { code: string, name: string }
interface CompanyRow { id: string, name: string }

const list = ref<Announcement[]>([])
const plans = ref<Plan[]>([])
const companies = ref<CompanyRow[]>([])
const error = ref('')
const notice = ref('')
const busy = ref(false)
const manage = computed(() => can('announcements.manage'))
const form = reactive({ title: '', body: '', audience: 'all' as Announcement['audience'], planCodes: [] as string[], tenantIds: [] as string[], publish: true })
const ready = computed(() => form.title.trim().length >= 3 && form.body.trim().length > 0
  && (form.audience !== 'plans' || form.planCodes.length > 0) && (form.audience !== 'tenants' || form.tenantIds.length > 0))
const stateOf = (a: Announcement) => a.archivedAt ? 'archived' : a.publishedAt ? 'published' : 'draft'
const fmt = (d: string | null) => d ? formatShortDate(new Date(d)) : '—'

async function load() {
  try { list.value = await ops<Announcement[]>('/announcements') }
  catch (err) { error.value = apiErrorOf(err).message }
}
onMounted(async () => {
  await load()
  try {
    plans.value = await ops<Plan[]>('/plans')
    // Повний список без пагінації (`/tenants`, як у старій панелі) — потрібен для чекбоксів адресації, а не для перегляду сторінками
    if (manage.value) companies.value = await ops<CompanyRow[]>('/tenants')
  }
  catch { /* довідники — необов'язково для перегляду */ }
})

async function create() {
  if (!ready.value || busy.value) return
  error.value = ''
  busy.value = true
  try {
    await ops('/announcements', { method: 'POST', body: { title: form.title.trim(), body: form.body.trim(), audience: form.audience, publish: form.publish, planCodes: form.audience === 'plans' ? form.planCodes : [], tenantIds: form.audience === 'tenants' ? form.tenantIds : [] } })
    notice.value = t('opsConsole.announcementsPage.created')
    Object.assign(form, { title: '', body: '', audience: 'all', planCodes: [], tenantIds: [], publish: true })
    await load()
  }
  catch (err) { error.value = apiErrorOf(err).message }
  finally { busy.value = false }
}
async function act(a: Announcement, kind: 'publish' | 'archive') {
  if (kind === 'archive' && !confirm(t('opsConsole.announcementsPage.archiveConfirm', { title: a.title }))) return
  error.value = ''
  try { await ops(`/announcements/${a.id}/${kind}`, { method: 'POST' }); await load() }
  catch (err) { error.value = apiErrorOf(err).message }
}
</script>

<template>
  <section>
    <h1 class="title">{{ t('opsConsole.nav.announcements') }}</h1>
    <p class="help">{{ t('opsConsole.announcementsPage.hint') }}</p>
    <p v-if="error" class="error-text" role="alert">{{ error }}</p>
    <p v-if="notice" class="note teal" role="status">{{ notice }} <button type="button" class="link" @click="notice = ''">×</button></p>

    <form v-if="manage" class="card create" data-testid="ops-announcement-create" @submit.prevent="create">
      <h2>{{ t('opsConsole.announcementsPage.create') }}</h2>
      <div class="row">
        <label class="field-wrap"><span class="label">{{ t('opsConsole.announcementsPage.f.title') }}</span><input v-model="form.title" class="field" maxlength="200"></label>
        <label class="field-wrap"><span class="label">{{ t('opsConsole.announcementsPage.f.audience') }}</span>
          <select v-model="form.audience" class="field"><option v-for="a in (['all', 'plans', 'tenants'] as const)" :key="a" :value="a">{{ t(`opsConsole.announcementsPage.audience.${a}`) }}</option></select>
        </label>
      </div>
      <label class="field-wrap"><span class="label">{{ t('opsConsole.announcementsPage.f.body') }}</span><textarea v-model="form.body" class="field" rows="4" maxlength="5000" /></label>
      <fieldset v-if="form.audience === 'plans'" class="picks">
        <legend class="help">{{ t('opsConsole.announcementsPage.f.plans') }}</legend>
        <label v-for="p in plans" :key="p.code" class="pick"><input v-model="form.planCodes" type="checkbox" :value="p.code">{{ p.name }}</label>
      </fieldset>
      <fieldset v-if="form.audience === 'tenants'" class="picks">
        <legend class="help">{{ t('opsConsole.announcementsPage.f.tenants') }}</legend>
        <label v-for="c in companies" :key="c.id" class="pick"><input v-model="form.tenantIds" type="checkbox" :value="c.id">{{ c.name }}</label>
      </fieldset>
      <label class="pick"><input v-model="form.publish" type="checkbox">{{ t('opsConsole.announcementsPage.f.publish') }}</label>
      <div class="chips"><button type="submit" class="btn primary" :disabled="!ready || busy">{{ t('opsConsole.announcementsPage.create') }}</button></div>
    </form>

    <ul v-if="list.length" class="cards">
      <li v-for="a in list" :key="a.id" class="card">
        <div class="chips">
          <span class="badge" :class="stateOf(a) === 'published' ? 'teal' : stateOf(a) === 'draft' ? 'sun' : 'muted'">{{ t(`opsConsole.announcementsPage.state.${stateOf(a)}`) }}</span>
          <b>{{ a.title }}</b>
        </div>
        <p class="body">{{ a.body }}</p>
        <p class="muted">{{ t(`opsConsole.announcementsPage.audience.${a.audience}`) }} · {{ fmt(a.publishedAt ?? a.createdAt) }} · {{ t('opsConsole.announcementsPage.readers', { n: a.readers }) }}</p>
        <div v-if="manage" class="chips">
          <button v-if="stateOf(a) === 'draft'" type="button" class="btn ghost small" @click="act(a, 'publish')">{{ t('opsConsole.announcementsPage.publish') }}</button>
          <button v-if="stateOf(a) === 'published'" type="button" class="btn ghost small" @click="act(a, 'archive')">{{ t('opsConsole.announcementsPage.archive') }}</button>
        </div>
      </li>
    </ul>
    <p v-else class="muted">{{ t('opsConsole.announcementsPage.empty') }}</p>
  </section>
</template>

<style scoped>
.title { margin: 0 0 var(--space-2); font-size: var(--font-size-title-l); font-weight: 900; }
.create { margin-bottom: var(--space-4); display: grid; gap: var(--space-2); }
.row { display: grid; grid-template-columns: repeat(auto-fit, minmax(200px, 1fr)); gap: var(--space-2); }
.field-wrap { display: grid; gap: var(--space-1); font-size: var(--font-size-body-s); }
.picks { border: none; margin: 0; padding: 0; display: flex; flex-wrap: wrap; gap: var(--space-2) var(--space-4); }
.pick { display: inline-flex; align-items: center; gap: var(--space-2); font-size: var(--font-size-body-s); font-weight: 700; }
.pick input { width: auto; }
.cards { list-style: none; margin: 0; padding: 0; display: grid; gap: var(--space-3); }
.body { white-space: pre-wrap; }
</style>
