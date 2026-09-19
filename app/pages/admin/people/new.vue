<script setup lang="ts">
definePageMeta({ layout: 'admin', middleware: 'admin-scope', requiredScope: 'people.invite' })
const { t } = useI18n()
const { api } = useApi()
const busy = ref(false)
const error = ref('')
async function submit(payload: Record<string, unknown>) {
  busy.value = true
  error.value = ''
  try {
    const p = await api<{ id: string }>('/people', { method: 'POST', body: payload })
    await navigateTo(`/admin/people/${p.id}`)
  }
  catch (err) { error.value = apiErrorOf(err).message }
  finally { busy.value = false }
}
</script>
<template>
  <div>
    <NuxtLink to="/admin/people" class="back">← {{ t('admin.nav.people') }}</NuxtLink>
    <h1>{{ t('people.createTitle') }}</h1>
    <p v-if="error" class="error" role="alert">{{ error }}</p>
    <PersonForm mode="create" :busy="busy" @submit="submit" @cancel="navigateTo('/admin/people')" />
  </div>
</template>
<style scoped>
.back { color: var(--color-ink-muted); text-decoration: none; font-size: var(--font-size-body-s); }
h1 { margin: var(--space-2) 0 var(--space-4); font-weight: 900; }
.error { color: var(--color-coral-ink); }
</style>
