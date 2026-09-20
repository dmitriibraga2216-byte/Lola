<script setup lang="ts">
/**
 * Сертифікати (мокап Certificates): по курсам — Назва · Формат · Видано · Термін дії · Остання видача · Опубліковано.
 * Шаблон один (PDF, docs/14); номер, срок и публичная страница проверки — наше дополнение. Бейджи — R3, вкладки нет.
 */
definePageMeta({ layout: 'admin', middleware: 'admin-scope', requiredScope: 'report.team' })
const { t } = useI18n()
const { api } = useApi()

interface Row { courseId: string | null, title: string | null, published: boolean, format: string, issued: number, active: number, revoked: number, lastIssuedAt: string, validityMonths: number | null }
const rows = ref<Row[]>([])
const error = ref('')
onMounted(async () => { try { rows.value = await api<Row[]>('/certificates/summary') } catch (err) { error.value = apiErrorOf(err).message } })
const total = computed(() => rows.value.reduce((s, r) => s + r.issued, 0))
const fmt = (s: string) => new Date(s).toLocaleDateString('uk-UA')
</script>

<template>
  <div>
    <PageHeader :title="t('certificates.title')" :subtitle="t('certificates.hint')" :crumbs="[{ label: t('admin.section.learning') }, { label: t('certificates.title') }]" />
    <p v-if="error" class="error-text" role="alert">{{ error }}</p>
    <div class="chips"><span class="chip on">{{ t('certificates.title') }} · {{ total }}</span></div>
    <div class="table-wrap card">
      <table class="table">
        <thead><tr><th>{{ t('certificates.name') }}</th><th>{{ t('certificates.format') }}</th><th>{{ t('certificates.issued') }}</th><th>{{ t('certificates.validity') }}</th><th>{{ t('certificates.lastIssued') }}</th><th>{{ t('certificates.published') }}</th></tr></thead>
        <tbody>
          <tr v-if="!rows.length"><td colspan="6" class="muted">{{ t('certificates.empty') }}</td></tr>
          <tr v-for="r in rows" :key="r.courseId ?? 'none'">
            <td><NuxtLink v-if="r.courseId" :to="`/admin/courses/${r.courseId}`" class="link">{{ r.title }}</NuxtLink><span v-else class="muted">—</span></td>
            <td>PDF · {{ t('certificates.template') }}</td>
            <td>{{ r.issued }}<span v-if="r.revoked" class="muted"> · {{ t('certificates.revoked', { n: r.revoked }) }}</span></td>
            <td>{{ r.validityMonths ? t('certificates.months', { n: r.validityMonths }) : t('certificates.unlimited') }}</td>
            <td>{{ fmt(r.lastIssuedAt) }}</td>
            <td><span class="badge" :class="r.published ? 'teal' : 'muted'">{{ r.published ? t('common.yes') : t('common.no') }}</span></td>
          </tr>
        </tbody>
      </table>
    </div>
  </div>
</template>

<style scoped>
.chips { margin-bottom: var(--space-3); }
</style>
