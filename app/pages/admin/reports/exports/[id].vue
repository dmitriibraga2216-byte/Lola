<script setup lang="ts">
definePageMeta({ layout: 'admin', middleware: 'admin-scope', requiredScope: 'report.team' })
const { t } = useI18n()
const { api } = useApi()
const route = useRoute()
const e = ref<{ id: string, report: string, status: string, rows: number | null, url: string | null, expired: boolean, expiresAt: string | null } | null>(null)
const error = ref('')
async function load() { try { e.value = await api(`/exports/${route.params.id}`) } catch (err) { error.value = apiErrorOf(err).message } }
onMounted(load)
</script>
<template>
  <div>
    <NuxtLink to="/admin/reports/exports" class="back">← {{ t('reports.myExports') }}</NuxtLink>
    <p v-if="error" class="error" role="alert">{{ error }}</p>
    <section v-if="e" class="card">
      <h1>{{ t(`reports.${e.report}`, e.report) }}</h1>
      <p class="sub">{{ t(`reports.exportStatus.${e.status}`) }}<template v-if="e.rows != null"> · {{ e.rows }} {{ t('reports.rows').toLowerCase() }}</template></p>
      <a v-if="e.url" :href="e.url" class="primary" target="_blank" rel="noopener">{{ t('reports.download') }}</a>
      <p v-else-if="e.expired" class="error">{{ t('reports.exportExpired') }}</p>
      <button v-else-if="e.status !== 'failed'" class="chip" @click="load">{{ t('common.loading') }}</button>
    </section>
  </div>
</template>
<style scoped>
.back { color: var(--color-ink-muted); text-decoration: none; font-size: var(--font-size-body-s); }
h1 { margin: 0; font-weight: 900; }
.card { background: var(--color-bg-soft); border-radius: var(--radius-l); padding: var(--space-4); display: grid; gap: var(--space-2); max-width: 520px; margin-top: var(--space-2); }
.primary { font: inherit; font-weight: 800; background: var(--color-sun); color: var(--color-ink); border-radius: var(--radius-pill); padding: var(--space-2) var(--space-4); text-decoration: none; justify-self: start; }
.chip { font: inherit; font-size: var(--font-size-body-s); font-weight: 700; border: 1px solid var(--color-bg-line); background: transparent; color: var(--color-ink); border-radius: var(--radius-pill); padding: var(--space-1) var(--space-3); cursor: pointer; justify-self: start; }
.sub { font-size: var(--font-size-body-s); color: var(--color-ink-faint); margin: 0; }
.error { color: var(--color-coral-ink); }
</style>
