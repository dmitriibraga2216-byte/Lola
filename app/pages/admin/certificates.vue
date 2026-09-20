<script setup lang="ts">
/**
 * Сертифікати (мокап Certificates): по курсам — Назва · Формат · Видано · Термін дії · Остання видача · Опубліковано.
 * Шаблон один (PDF, docs/14); номер, срок и публичная страница проверки — наше дополнение. Бейджи — R3, вкладки нет.
 * Нижче — докс/33 D-065: список виданих сертифікатів (пошук/фільтри, відкликання з причиною) —
 * `GET /certificates` і `POST /certificates/:id/revoke` вже мали API, вітрини не було.
 */
definePageMeta({ layout: 'admin', middleware: 'admin-scope', requiredScope: 'report.team' })
const { t } = useI18n()
const { api } = useApi()

interface Row { courseId: string | null, title: string | null, published: boolean, format: string, issued: number, active: number, revoked: number, lastIssuedAt: string, validityMonths: number | null }
interface Cert { id: string, number: string, userId: string, fullName: string, score: string | null, issuedAt: string, validUntil: string | null, revokedAt: string | null, revokeReason: string | null, courseId: string | null, courseTitle: string | null }
const rows = ref<Row[]>([])
const error = ref('')
onMounted(async () => { try { rows.value = await api<Row[]>('/certificates/summary') } catch (err) { error.value = apiErrorOf(err).message } })
const total = computed(() => rows.value.reduce((s, r) => s + r.issued, 0))
const fmt = (s: string) => new Date(s).toLocaleDateString('uk-UA')

// ── Видані сертифікати: пошук/фільтри, відкликання (D-065) ──
const certs = ref<Cert[]>([])
const certsError = ref('')
const certsLoading = ref(false)
const filterCourseId = ref<string>('')
const filterStatus = ref<'' | 'active' | 'revoked'>('')
const filterQ = ref('')
const revoking = ref<{ id: string, reason: string } | null>(null)

async function loadCerts() {
  certsLoading.value = true; certsError.value = ''
  try {
    certs.value = await api<Cert[]>('/certificates', { query: { ...(filterCourseId.value ? { courseId: filterCourseId.value } : {}), ...(filterStatus.value ? { status: filterStatus.value } : {}), ...(filterQ.value.trim() ? { q: filterQ.value.trim() } : {}) } })
  }
  catch (err) { certsError.value = apiErrorOf(err).message }
  finally { certsLoading.value = false }
}
onMounted(loadCerts)
let timer: ReturnType<typeof setTimeout>
watch(filterQ, () => { clearTimeout(timer); timer = setTimeout(loadCerts, 300) })
watch([filterCourseId, filterStatus], loadCerts)

function browseCourse(courseId: string | null) { filterCourseId.value = courseId ?? ''; loadCerts() }

async function submitRevoke() {
  if (!revoking.value) return
  try {
    await api(`/certificates/${revoking.value.id}/revoke`, { method: 'POST', body: { reason: revoking.value.reason } })
    revoking.value = null
    await loadCerts()
  }
  catch (err) { certsError.value = apiErrorOf(err).message }
}
</script>

<template>
  <div>
    <PageHeader :title="t('certificates.title')" :subtitle="t('certificates.hint')" :crumbs="[{ label: t('admin.section.learning') }, { label: t('certificates.title') }]" />
    <p v-if="error" class="error-text" role="alert">{{ error }}</p>
    <div class="chips"><span class="chip on">{{ t('certificates.title') }} · {{ total }}</span></div>
    <div class="table-wrap card">
      <table class="table">
        <thead><tr><th>{{ t('certificates.name') }}</th><th>{{ t('certificates.format') }}</th><th>{{ t('certificates.issued') }}</th><th>{{ t('certificates.validity') }}</th><th>{{ t('certificates.lastIssued') }}</th><th>{{ t('certificates.published') }}</th><th /></tr></thead>
        <tbody>
          <tr v-if="!rows.length"><td colspan="7" class="muted">{{ t('certificates.empty') }}</td></tr>
          <tr v-for="r in rows" :key="r.courseId ?? 'none'">
            <td><NuxtLink v-if="r.courseId" :to="`/admin/courses/${r.courseId}`" class="link">{{ r.title }}</NuxtLink><span v-else class="muted">—</span></td>
            <td>PDF · {{ t('certificates.template') }}</td>
            <td>{{ r.issued }}<span v-if="r.revoked" class="muted"> · {{ t('certificates.revoked', { n: r.revoked }) }}</span></td>
            <td>{{ r.validityMonths ? t('certificates.months', { n: r.validityMonths }) : t('certificates.unlimited') }}</td>
            <td>{{ fmt(r.lastIssuedAt) }}</td>
            <td><span class="badge" :class="r.published ? 'teal' : 'muted'">{{ r.published ? t('common.yes') : t('common.no') }}</span></td>
            <td><button v-if="r.courseId" type="button" class="btn small" @click="browseCourse(r.courseId)">{{ t('certificates.browseIssued') }}</button></td>
          </tr>
        </tbody>
      </table>
    </div>

    <h2 class="issued-title">{{ t('certificates.issuedTitle') }}</h2>
    <div class="filters">
      <input v-model="filterQ" class="field" type="search" :placeholder="t('certificates.searchHint')" :aria-label="t('certificates.searchHint')">
      <select v-model="filterCourseId" class="field" :aria-label="t('certificates.name')">
        <option value="">{{ t('certificates.allCourses') }}</option>
        <option v-for="r in rows" :key="r.courseId ?? 'none'" :value="r.courseId ?? ''">{{ r.title }}</option>
      </select>
      <select v-model="filterStatus" class="field" :aria-label="t('certificates.stateLabel')">
        <option value="">{{ t('certificates.allStates') }}</option>
        <option value="active">{{ t('certificates.stateActive') }}</option>
        <option value="revoked">{{ t('certificates.stateRevoked') }}</option>
      </select>
    </div>
    <p v-if="certsError" class="error-text" role="alert">{{ certsError }}</p>
    <div class="table-wrap card">
      <table class="table">
        <thead><tr><th>{{ t('certificates.person') }}</th><th>{{ t('certificates.name') }}</th><th>{{ t('certificates.number') }}</th><th>{{ t('certificates.issued') }}</th><th>{{ t('certificates.validity') }}</th><th>{{ t('certificates.stateLabel') }}</th><th /></tr></thead>
        <tbody>
          <tr v-if="certsLoading"><td colspan="7" class="muted">{{ t('common.loading') }}</td></tr>
          <tr v-else-if="!certs.length"><td colspan="7" class="muted">{{ t('certificates.empty') }}</td></tr>
          <template v-for="c in certs" :key="c.id">
            <tr>
              <td>{{ c.fullName }}</td>
              <td><NuxtLink v-if="c.courseId" :to="`/admin/courses/${c.courseId}`" class="link">{{ c.courseTitle }}</NuxtLink><span v-else class="muted">—</span></td>
              <td class="mono">{{ c.number }}</td>
              <td>{{ fmt(c.issuedAt) }}</td>
              <td>{{ c.validUntil ? fmt(c.validUntil) : t('certificates.unlimited') }}</td>
              <td><span class="badge" :class="c.revokedAt ? 'coral' : 'teal'">{{ c.revokedAt ? t('certificates.stateRevoked') : t('certificates.stateActive') }}</span></td>
              <td class="actions">
                <a :href="`/api/v1/certificates/${c.id}/pdf`" target="_blank" rel="noopener" class="link">{{ t('cert.downloadPdf') }}</a>
                <button v-if="!c.revokedAt" type="button" class="btn small danger" @click="revoking = revoking?.id === c.id ? null : { id: c.id, reason: '' }">{{ t('certificates.revoke') }}</button>
              </td>
            </tr>
            <tr v-if="revoking?.id === c.id">
              <td colspan="7">
                <form class="revoke-form" @submit.prevent="submitRevoke">
                  <input v-model="revoking.reason" type="text" maxlength="500" minlength="10" required class="field" :placeholder="t('certificates.revokeReasonHint')" :aria-label="t('certificates.revokeReasonHint')">
                  <button type="submit" class="btn small danger">{{ t('certificates.revokeConfirm') }}</button>
                  <button type="button" class="btn small ghost" @click="revoking = null">{{ t('common.cancel') }}</button>
                </form>
              </td>
            </tr>
            <tr v-else-if="c.revokedAt && c.revokeReason">
              <td colspan="7" class="muted revoke-reason">{{ t('certificates.revokedReasonLine', { reason: c.revokeReason }) }}</td>
            </tr>
          </template>
        </tbody>
      </table>
    </div>
  </div>
</template>

<style scoped>
.chips { margin-bottom: var(--space-3); }
.issued-title { margin: var(--space-5) 0 var(--space-3); font-weight: 800; }
.filters { display: flex; gap: var(--space-2); flex-wrap: wrap; margin-bottom: var(--space-3); }
.filters .field { min-width: 180px; }
.actions { display: flex; gap: var(--space-2); align-items: center; flex-wrap: wrap; }
.mono { font-variant-numeric: tabular-nums; }
.revoke-form { display: flex; gap: var(--space-2); align-items: center; flex-wrap: wrap; padding: var(--space-2) 0; }
.revoke-form .field { flex: 1 1 240px; }
.revoke-reason { font-size: var(--font-size-body-s); }
</style>
