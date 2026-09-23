<script setup lang="ts">
/**
 * Прийом заявок на навчання (мокап LearningRequests, докс/10 §14.1): вкладки «Завдання» /
 * «Траєкторії навчання» (для Lola — програми і траєкторії разом, `17` §1). Відхилення — з причиною.
 */
definePageMeta({ layout: 'admin', middleware: 'admin-scope', requiredScope: 'assignment.create' })

const { t, locale } = useI18n()
const { api } = useApi()

type Kind = 'tasks' | 'trajectories'
const tab = ref<Kind>('tasks')

interface Row {
  id: string
  kind: 'course' | 'program' | 'trajectory'
  title: string
  userId: string
  fullName: string
  positionName: string | null
  locationName: string | null
  requestedAt: string
  status: 'pending' | 'approved' | 'rejected'
  decisionReason: string | null
}

const rows = ref<Row[]>([])
const reasons = ref<Record<string, string>>({})
const error = ref('')
const notice = ref('')
const busy = ref('')

async function load() {
  error.value = ''
  try { rows.value = await api<Row[]>('/manage/catalog/requests', { query: { kind: tab.value } }) }
  catch (err) { error.value = apiErrorOf(err).message }
}
onMounted(load)
watch(tab, load)

const counts = computed(() => ({
  tasks: tab.value === 'tasks' ? rows.value.filter(r => r.status === 'pending').length : null,
  trajectories: tab.value === 'trajectories' ? rows.value.filter(r => r.status === 'pending').length : null,
}))

const fmtDate = (iso: string) => new Date(iso).toLocaleDateString(locale.value === 'ru' ? 'ru-RU' : locale.value === 'uk' ? 'uk-UA' : 'en-GB', { day: '2-digit', month: '2-digit', year: 'numeric' })

function decidePath(r: Row): string {
  if (r.kind === 'course') return `/enrollments/${r.id}/decide`
  if (r.kind === 'program') return `/program-enrollments/${r.id}/decide`
  return `/trajectories/enrollments/${r.id}/decide`
}

async function decide(r: Row, approve: boolean) {
  const reason = (reasons.value[r.id] ?? '').trim()
  if (!approve && !reason) { error.value = t('learningRequests.reasonRequired'); return }
  busy.value = r.id
  error.value = ''
  try {
    await api(decidePath(r), { method: 'POST', body: { approve, reason: reason || undefined } })
    notice.value = approve ? t('learningRequests.approved', { name: r.fullName }) : t('learningRequests.rejected', { name: r.fullName })
    await load()
  }
  catch (err) {
    error.value = apiErrorOf(err).message
  }
  finally {
    busy.value = ''
  }
}
</script>

<template>
  <div>
    <PageHeader :title="t('learningRequests.title')" :crumbs="[{ label: t('admin.section.learning') }, { label: t('learningRequests.title') }]" :subtitle="t('learningRequests.hint')" />

    <div class="chips tabs" role="tablist">
      <button type="button" role="tab" :aria-selected="tab === 'tasks'" :class="['chip', { on: tab === 'tasks' }]" @click="tab = 'tasks'">
        {{ t('learningRequests.tabTasks') }}<template v-if="counts.tasks"> · {{ counts.tasks }}</template>
      </button>
      <button type="button" role="tab" :aria-selected="tab === 'trajectories'" :class="['chip', { on: tab === 'trajectories' }]" @click="tab = 'trajectories'">
        {{ t('learningRequests.tabTrajectories') }}<template v-if="counts.trajectories"> · {{ counts.trajectories }}</template>
      </button>
    </div>

    <p v-if="error" class="error-text" role="alert">{{ error }}</p>
    <p v-if="notice" class="note teal">{{ notice }}</p>

    <div class="table-wrap">
      <table class="table">
        <thead>
          <tr>
            <th>{{ t('learningRequests.colSubject') }}</th>
            <th>{{ t('learningRequests.colPerson') }}</th>
            <th>{{ t('learningRequests.colDate') }}</th>
            <th>{{ t('learningRequests.colStatus') }}</th>
            <th />
          </tr>
        </thead>
        <tbody>
          <tr v-for="r in rows" :key="`${r.kind}:${r.id}`">
            <td><b>{{ r.title }}</b></td>
            <td>
              {{ r.fullName }}
              <span class="sub"><template v-if="r.positionName">{{ r.positionName }}</template><template v-if="r.locationName"> · {{ r.locationName }}</template></span>
            </td>
            <td>{{ fmtDate(r.requestedAt) }}</td>
            <td>
              <span :class="['badge', r.status === 'pending' ? 'sun' : r.status === 'approved' ? 'teal' : 'coral']">{{ t(`learningRequests.status.${r.status}`) }}</span>
              <span v-if="r.decisionReason" class="sub">{{ r.decisionReason }}</span>
            </td>
            <td>
              <div v-if="r.status === 'pending'" class="actions">
                <input v-model="reasons[r.id]" class="field" :placeholder="t('learningRequests.reasonPh')" :aria-label="t('learningRequests.reasonPh')">
                <button class="btn primary small" :disabled="busy === r.id" @click="decide(r, true)">{{ t('learningRequests.approve') }}</button>
                <button class="btn ghost small" :disabled="busy === r.id" @click="decide(r, false)">{{ t('learningRequests.reject') }}</button>
              </div>
            </td>
          </tr>
          <tr v-if="rows.length === 0">
            <td colspan="5" class="muted">{{ t('learningRequests.empty') }}</td>
          </tr>
        </tbody>
      </table>
    </div>
  </div>
</template>

<style scoped>
.tabs { margin-bottom: var(--space-4); }
.sub { display: block; font-size: var(--font-size-body-s); color: var(--color-ink-muted); }
.actions { display: flex; gap: var(--space-2); flex-wrap: wrap; align-items: center; min-width: 240px; }
.actions .field { flex: 1; min-width: 140px; }
</style>
