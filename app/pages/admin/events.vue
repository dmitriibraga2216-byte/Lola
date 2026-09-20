<script setup lang="ts">
/** Події (мокап Events, docs/21 §3.4): таблица Назва · Коли · Де · Запрошено · Опубліковано, «Додати подію». */
import type { ContentBlock } from '../../../shared/schemas/content'
definePageMeta({ layout: 'admin', middleware: 'admin-scope', requiredScope: 'meetup.manage' })
const { t } = useI18n()
const { api } = useApi()
interface E { id: string, title: string, startsAt: string, endsAt: string, status: string, locationName: string | null, address: string | null, invited: number, registered: number, published: boolean, capacity: number | null }
const items = ref<E[]>([])
const error = ref('')
const adding = ref(false)
const busy = ref(false)
const locations = ref<{ id: string, name: string }[]>([])
const form = reactive({ title: '', description: [{ id: 'b1', type: 'text', html: '<p></p>' }] as ContentBlock[], startsAt: '', endsAt: '', locationId: '', address: '', capacity: '', registrationRequired: false, audienceLocationIds: [] as string[], publish: true })
const when = (s: string) => new Date(s).toLocaleString('uk-UA', { day: '2-digit', month: '2-digit', year: 'numeric', hour: '2-digit', minute: '2-digit' })
async function load() { try { items.value = await api<E[]>('/events', { query: { all: '1' } }); locations.value = await api('/refs/locations') } catch (err) { error.value = apiErrorOf(err).message } }
onMounted(load)
async function save() {
  busy.value = true; error.value = ''
  try {
    await api('/events', { method: 'POST', body: { title: form.title, description: form.description, startsAt: new Date(form.startsAt).toISOString(), endsAt: form.endsAt ? new Date(form.endsAt).toISOString() : undefined, locationId: form.locationId || null, address: form.address || null, capacity: form.capacity ? Number(form.capacity) : null, registrationRequired: form.registrationRequired, audienceLocationIds: form.audienceLocationIds, publish: form.publish } })
    Object.assign(form, { title: '', description: [{ id: `b${Date.now()}`, type: 'text', html: '<p></p>' }], startsAt: '', endsAt: '', locationId: '', address: '', capacity: '', registrationRequired: false, audienceLocationIds: [], publish: true }); adding.value = false
    await load()
  } catch (err) { error.value = apiErrorOf(err).message } finally { busy.value = false }
}
</script>
<template>
  <div>
    <PageHeader :title="t('events.title')" :crumbs="[{ label: t('admin.section.learning') }, { label: t('admin.section.info') }, { label: t('events.title') }]">
      <template #actions><button class="btn primary" @click="adding = !adding">{{ t('events.add') }}</button></template>
    </PageHeader>
    <p v-if="error" class="error-text" role="alert">{{ error }}</p>
    <section v-if="adding" class="card form">
      <label class="label" for="e-title">{{ t('events.f.title') }}</label><input id="e-title" v-model="form.title" class="field" maxlength="200">
      <p class="label top">{{ t('events.f.text') }}</p>
      <BlockEditor v-model="form.description" />
      <div class="row top">
        <label class="col"><span class="label">{{ t('events.f.starts') }}</span><input v-model="form.startsAt" class="field" type="datetime-local"></label>
        <label class="col"><span class="label">{{ t('events.f.ends') }}</span><input v-model="form.endsAt" class="field" type="datetime-local"></label>
      </div>
      <div class="row top">
        <label class="col"><span class="label">{{ t('events.f.where') }}</span><select v-model="form.locationId" class="field"><option value="">{{ t('events.allLocations') }}</option><option v-for="l in locations" :key="l.id" :value="l.id">{{ l.name }}</option></select></label>
        <label class="col"><span class="label">{{ t('events.f.address') }}</span><input v-model="form.address" class="field" maxlength="300"></label>
        <label class="col"><span class="label">{{ t('events.f.capacity') }}</span><input v-model="form.capacity" class="field" type="number" min="1" max="5000"></label>
      </div>
      <p class="label top">{{ t('events.f.invited') }}</p>
      <div class="chips"><label v-for="l in locations" :key="l.id" :class="['chip', { on: form.audienceLocationIds.includes(l.id) }]"><input v-model="form.audienceLocationIds" type="checkbox" :value="l.id" class="sr">{{ l.name }}</label></div>
      <p class="help">{{ t('events.invitedHint') }}</p>
      <label class="toggle top"><input v-model="form.registrationRequired" type="checkbox"><span>{{ t('events.f.registration') }}</span></label>
      <label class="toggle top"><input v-model="form.publish" type="checkbox"><span>{{ t('news.publish') }}</span></label>
      <div class="actions top"><button class="btn primary" :disabled="busy || form.title.trim().length < 3 || !form.startsAt" @click="save">{{ t('common.save') }}</button><button class="btn ghost" @click="adding = false">{{ t('common.cancel') }}</button></div>
    </section>
    <div class="table-wrap">
      <table class="table">
        <thead><tr><th>{{ t('events.col.title') }}</th><th>{{ t('events.col.when') }}</th><th>{{ t('events.col.where') }}</th><th class="num">{{ t('events.col.invited') }}</th><th>{{ t('events.col.published') }}</th></tr></thead>
        <tbody>
          <tr v-for="e in items" :key="e.id">
            <td><b>{{ e.title }}</b><span class="sub">{{ t('events.registered', { n: e.registered }) }}<template v-if="e.capacity"> / {{ e.capacity }}</template></span></td>
            <td>{{ when(e.startsAt) }}</td>
            <td>{{ [e.locationName ?? t('events.allLocations'), e.address].filter(Boolean).join(', ') }}</td>
            <td class="num">{{ e.invited }}</td>
            <td><span :class="['badge', e.status === 'cancelled' ? 'coral' : e.published ? 'teal' : 'muted']">{{ e.status === 'cancelled' ? t('events.cancelled') : e.published ? t('events.published') : t('events.draft') }}</span></td>
          </tr>
          <tr v-if="!items.length"><td colspan="5" class="faint">{{ t('events.empty') }}</td></tr>
        </tbody>
      </table>
    </div>
  </div>
</template>
<style scoped>
.form { margin-bottom: var(--space-4); }
.top { margin-top: var(--space-3); }
.row { display: grid; grid-template-columns: repeat(auto-fit, minmax(180px, 1fr)); gap: var(--space-2); }
.col { display: grid; }
.actions { display: flex; gap: var(--space-2); }
.sr { position: absolute; opacity: 0; width: 1px; height: 1px; }
.chip { cursor: pointer; }
</style>
