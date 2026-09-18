<script setup lang="ts">
definePageMeta({ layout: 'admin', middleware: 'admin-scope', requiredScope: 'people.import' })

const { t } = useI18n()
const csrf = useCookie('lola_csrf')

interface ImportRowView {
  line: number
  fullName: string
  phone: string
  action: 'create' | 'update' | 'skip'
  errors: string[]
}
interface ImportStats {
  total: number
  create: number
  update: number
  skip: number
  errors: number
}

const file = ref<File | null>(null)
const jobId = ref('')
const stats = ref<ImportStats | null>(null)
const rows = ref<ImportRowView[]>([])
const applied = ref<{ created: number, updated: number } | null>(null)
const busy = ref(false)
const error = ref('')
const showOnlyErrors = ref(false)

const visibleRows = computed(() =>
  (showOnlyErrors.value ? rows.value.filter(r => r.errors.length > 0) : rows.value).slice(0, 200))

function onFile(e: Event) {
  file.value = (e.target as HTMLInputElement).files?.[0] ?? null
}

async function upload() {
  if (!file.value) return
  busy.value = true
  error.value = ''
  applied.value = null
  try {
    const form = new FormData()
    form.append('file', file.value)
    const res = await $fetch<{ data: { jobId: string, stats: ImportStats, rows: ImportRowView[] } }>(
      '/api/v1/people/import',
      { method: 'POST', body: form, headers: csrf.value ? { 'x-csrf-token': csrf.value } : {} },
    )
    jobId.value = res.data.jobId
    stats.value = res.data.stats
    rows.value = res.data.rows
  }
  catch (err) {
    error.value = apiErrorOf(err).message
  }
  finally {
    busy.value = false
  }
}

async function apply() {
  busy.value = true
  error.value = ''
  try {
    const res = await $fetch<{ data: { stats: { created: number, updated: number } } }>(
      `/api/v1/people/import/${jobId.value}/apply`,
      { method: 'POST', headers: csrf.value ? { 'x-csrf-token': csrf.value } : {} },
    )
    applied.value = res.data.stats
  }
  catch (err) {
    error.value = apiErrorOf(err).message
  }
  finally {
    busy.value = false
  }
}
</script>

<template>
  <div>
    <h1>{{ t('admin.nav.import') }}</h1>
    <p class="sub">
      {{ t('import.hint') }}
      <a href="/api/v1/people/import/template" download>{{ t('import.template') }}</a>
    </p>

    <div class="upload">
      <input type="file" accept=".xlsx,.csv" @change="onFile">
      <button class="primary" :disabled="!file || busy" @click="upload">
        {{ t('import.validate') }}
      </button>
    </div>

    <p v-if="error" class="error">{{ error }}</p>

    <template v-if="stats">
      <div class="stats">
        <div class="stat"><b>{{ stats.total }}</b><span>{{ t('import.total') }}</span></div>
        <div class="stat teal"><b>{{ stats.create }}</b><span>{{ t('import.toCreate') }}</span></div>
        <div class="stat sun"><b>{{ stats.update }}</b><span>{{ t('import.toUpdate') }}</span></div>
        <div class="stat coral"><b>{{ stats.skip }}</b><span>{{ t('import.toSkip') }}</span></div>
      </div>

      <div class="controls">
        <label class="check">
          <input v-model="showOnlyErrors" type="checkbox">
          {{ t('import.onlyErrors') }}
        </label>
        <button
          v-if="!applied"
          class="primary"
          :disabled="busy || stats.create + stats.update === 0"
          @click="apply"
        >
          {{ t('import.apply', { n: stats.create + stats.update }) }}
        </button>
        <a v-if="applied" class="report" :href="`/api/v1/people/import/${jobId}/report`" download>
          {{ t('import.downloadReport') }}
        </a>
      </div>

      <p v-if="applied" class="notice">
        {{ t('import.appliedResult', { created: applied.created, updated: applied.updated }) }}
      </p>

      <table class="table">
        <thead>
          <tr>
            <th>#</th>
            <th>{{ t('people.col.name') }}</th>
            <th>{{ t('person.phone') }}</th>
            <th>{{ t('import.action') }}</th>
            <th>{{ t('import.errors') }}</th>
          </tr>
        </thead>
        <tbody>
          <tr v-for="row in visibleRows" :key="row.line" :class="{ bad: row.errors.length > 0 }">
            <td class="sub">{{ row.line }}</td>
            <td>{{ row.fullName }}</td>
            <td>{{ row.phone }}</td>
            <td>{{ t(`import.actions.${row.action}`) }}</td>
            <td class="errors-cell">{{ row.errors.join('; ') }}</td>
          </tr>
        </tbody>
      </table>
      <p v-if="rows.length > 200" class="sub">{{ t('import.truncated', { shown: 200, total: rows.length }) }}</p>
    </template>
  </div>
</template>

<style scoped>
h1 {
  margin: 0 0 var(--space-2);
  font-weight: 900;
}

.sub {
  color: var(--color-ink-muted);
  font-size: var(--font-size-body-s);
}

.sub a {
  color: var(--color-teal-ink);
}

.upload {
  display: flex;
  gap: var(--space-3);
  align-items: center;
  margin: var(--space-4) 0;
  flex-wrap: wrap;
}

.primary {
  font: inherit;
  font-weight: 800;
  border: none;
  background: var(--color-sun);
  color: var(--color-ink);
  border-radius: var(--radius-pill);
  padding: var(--space-2) var(--space-5);
  cursor: pointer;
}

.primary:disabled {
  opacity: 0.5;
}

.stats {
  display: flex;
  gap: var(--space-3);
  margin-bottom: var(--space-4);
  flex-wrap: wrap;
}

.stat {
  background: var(--color-bg-soft);
  border-radius: var(--radius-m);
  padding: var(--space-3) var(--space-5);
  display: grid;
  text-align: center;
}

.stat b {
  font-size: var(--font-size-title-l);
  font-weight: 900;
}

.stat span {
  font-size: var(--font-size-body-s);
  color: var(--color-ink-muted);
}

.stat.teal b { color: var(--color-teal-ink); }
.stat.sun b { color: var(--color-sun-ink); }
.stat.coral b { color: var(--color-coral-ink); }

.controls {
  display: flex;
  align-items: center;
  gap: var(--space-4);
  margin-bottom: var(--space-3);
}

.check {
  display: flex;
  gap: var(--space-2);
  align-items: center;
  font-size: var(--font-size-body-s);
  color: var(--color-ink-muted);
}

.report {
  color: var(--color-teal-ink);
  font-weight: 700;
}

.notice {
  color: var(--color-teal-ink);
}

.table {
  width: 100%;
  border-collapse: collapse;
  background: var(--color-bg-soft);
  border-radius: var(--radius-m);
  overflow: hidden;
}

th {
  text-align: left;
  font-size: var(--font-size-body-s);
  color: var(--color-ink-muted);
  padding: var(--space-2) var(--space-3);
  border-bottom: 1px solid var(--color-bg-line);
}

td {
  padding: var(--space-2) var(--space-3);
  border-bottom: 1px solid var(--color-bg-line-soft);
}

.bad {
  background: color-mix(in srgb, var(--color-coral) 12%, transparent);
}

.errors-cell {
  color: var(--color-coral-ink);
  font-size: var(--font-size-body-s);
}

.error {
  color: var(--color-coral-ink);
}
</style>
