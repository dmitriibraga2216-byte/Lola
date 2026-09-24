<script setup lang="ts">
/** Події для сотрудника (docs/21 §5.1, §3.4): афиша, куда запрошен, запись с гостями. */
const { formatDateTime } = useFormat()
definePageMeta({ layout: 'learner' })
const { t } = useI18n()
const { api } = useApi()
interface E { id: string, title: string, startsAt: string, locationName: string | null, address: string | null, registrationRequired: boolean, registered: number, capacity: number | null, mine: boolean }
const items = ref<E[]>([])
const error = ref('')
const when = (s: string) => formatDateTime(new Date(s), { day: 'numeric', month: 'long', hour: '2-digit', minute: '2-digit' })
async function load() { try { items.value = await api<E[]>('/events') } catch (err) { error.value = apiErrorOf(err).message } }
onMounted(load)
async function register(e: E) { error.value = ''; try { await api(`/events/${e.id}/register`, { method: 'POST', body: { guestsCount: 0 } }); await load() } catch (err) { error.value = apiErrorOf(err).message } }
</script>
<template>
  <div>
    <h1>{{ t('events.title') }}</h1>
    <p v-if="error" class="error-text" role="alert">{{ error }}</p>
    <ul class="list">
      <li v-for="e in items" :key="e.id" class="card item">
        <b>{{ e.title }}</b>
        <span class="muted">{{ when(e.startsAt) }} · {{ [e.locationName ?? t('events.allLocations'), e.address].filter(Boolean).join(', ') }}</span>
        <span v-if="e.registrationRequired" class="row">
          <span class="muted">{{ t('events.registered', { n: e.registered }) }}<template v-if="e.capacity"> / {{ e.capacity }}</template></span>
          <span v-if="e.mine" class="badge teal">{{ t('events.youAreIn') }}</span>
          <button v-else class="btn primary small" @click="register(e)">{{ t('events.register') }}</button>
        </span>
      </li>
      <li v-if="!items.length" class="faint empty">{{ t('events.empty') }}</li>
    </ul>
  </div>
</template>
<style scoped>
h1 { margin: 0 0 var(--space-3); font-weight: 900; }
.list { list-style: none; margin: 0; padding: 0; display: grid; gap: var(--space-2); }
.item { display: grid; gap: var(--space-1); }
.item .muted { font-size: var(--font-size-body-s); }
.row { display: flex; gap: var(--space-2); align-items: center; justify-content: space-between; }
.empty { text-align: center; padding: var(--space-6); }
</style>
