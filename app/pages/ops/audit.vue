<script setup lang="ts">
/**
 * Консоль оператора → «Журнал» (docs/24 §4.8, docs/25 §7 п. 5): усі дії операторів
 * (`platform_audit`), опційно за компанією. Раніше такого екрана не було — старій панелі
 * `/ops` журнал не показував.
 */
definePageMeta({ layout: 'ops', middleware: 'ops-auth' })
const { t } = useI18n()
const { formatShortDate } = useFormat()
const { ops } = useOps()
const route = useRoute()

interface Row { id: string, adminEmail: string, action: string, subjectTenantId: string | null, entity: string, entityId: string | null, before: unknown, after: unknown, createdAt: string }

const rows = ref<Row[]>([])
const error = ref('')
const loading = ref(false)
const tenantId = ref(typeof route.query.tenantId === 'string' ? route.query.tenantId : '')
const limit = ref('100')

async function load() {
  loading.value = true
  error.value = ''
  try {
    const query = { limit: limit.value, ...(tenantId.value.trim() ? { tenantId: tenantId.value.trim() } : {}) }
    rows.value = await ops<Row[]>('/audit', { query })
  }
  catch (err) { error.value = apiErrorOf(err).message }
  finally { loading.value = false }
}
onMounted(load)
const fmtAt = (d: string) => formatShortDate(new Date(d))
const json = (v: unknown) => v == null ? '' : JSON.stringify(v, null, 1)
</script>

<template>
  <section>
    <h1 class="title">{{ t('opsConsole.nav.audit') }}</h1>
    <form class="filters" @submit.prevent="load">
      <label class="sr" for="a-tenant">{{ t('opsConsole.auditPage.tenantId') }}</label>
      <input id="a-tenant" v-model="tenantId" class="field" :placeholder="t('opsConsole.auditPage.tenantId')" autocomplete="off">
      <label class="sr" for="a-limit">{{ t('opsConsole.auditPage.limit') }}</label>
      <select id="a-limit" v-model="limit" class="field">
        <option v-for="n in ['50', '100', '200', '500']" :key="n" :value="n">{{ n }}</option>
      </select>
      <button type="submit" class="btn ghost" :disabled="loading">{{ t('opsConsole.auditPage.apply') }}</button>
    </form>
    <p v-if="error" class="error-text" role="alert">{{ error }}</p>
    <div class="table-wrap">
      <table class="table" data-testid="ops-audit">
        <thead>
          <tr>
            <th>{{ t('opsConsole.auditPage.when') }}</th>
            <th>{{ t('opsConsole.auditPage.who') }}</th>
            <th>{{ t('opsConsole.auditPage.action') }}</th>
            <th>{{ t('opsConsole.auditPage.tenant') }}</th>
            <th>{{ t('opsConsole.auditPage.entity') }}</th>
            <th />
          </tr>
        </thead>
        <tbody>
          <tr v-for="r in rows" :key="r.id">
            <td>{{ fmtAt(r.createdAt) }}</td>
            <td>{{ r.adminEmail }}</td>
            <td><b>{{ r.action }}</b></td>
            <td><NuxtLink v-if="r.subjectTenantId" :to="`/ops/companies/${r.subjectTenantId}`" class="link">{{ r.subjectTenantId.slice(0, 8) }}</NuxtLink><span v-else class="muted">—</span></td>
            <td>{{ r.entity }}<span v-if="r.entityId" class="sub">{{ r.entityId }}</span></td>
            <td>
              <details v-if="r.before || r.after">
                <summary class="muted">{{ t('opsConsole.auditPage.details') }}</summary>
                <pre v-if="r.before" class="diff">− {{ json(r.before) }}</pre>
                <pre v-if="r.after" class="diff">+ {{ json(r.after) }}</pre>
              </details>
            </td>
          </tr>
          <tr v-if="!rows.length && !loading"><td colspan="6" class="muted">{{ t('opsConsole.auditPage.empty') }}</td></tr>
        </tbody>
      </table>
    </div>
  </section>
</template>

<style scoped>
.title { margin: 0 0 var(--space-3); font-size: var(--font-size-title-l); font-weight: 900; }
.filters { display: flex; flex-wrap: wrap; gap: var(--space-2); align-items: end; margin-bottom: var(--space-4); }
.filters .field { max-width: 320px; }
.sr { position: absolute; width: 1px; height: 1px; overflow: hidden; clip: rect(0 0 0 0); white-space: nowrap; }
.diff { font-size: 12px; white-space: pre-wrap; overflow-wrap: anywhere; margin: var(--space-1) 0; }
</style>
