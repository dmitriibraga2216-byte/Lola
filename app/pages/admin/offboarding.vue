<script setup lang="ts">
/**
 * Звільнення — `/admin/offboarding` (docs/v2/33-lifecycle.md §5.4, форма §6.2).
 *
 * Список активних випадків: людина, точка, посада, причина, останній робочий день, стан,
 * відповідальний. Дії картки — «Передачу справ завершено», «Завершити», «Скасувати».
 * Усі рішення ухвалює сервер (CLAUDE.md п. 3): екран лише показує стан і кнопки.
 */
import { OFFBOARDING_REASONS, OFFBOARDING_STATES } from '#shared/enums'
import type { OffboardingReason, OffboardingState } from '#shared/enums'
const { formatDate } = useFormat()

definePageMeta({ layout: 'admin', middleware: 'admin-scope', requiredScope: 'offboarding.start' })

const { t } = useI18n()
const { api } = useApi()
const { hasScope } = useAuth()

interface Row {
  id: string
  userId: string
  fullName: string
  locationName: string | null
  positionName: string | null
  state: OffboardingState
  reasonCode: OffboardingReason
  reasonText: string | null
  lastWorkingDay: string
  responsibleName: string | null
  handoverDoneAt: string | null
  completedAt: string | null
  exitInterviewEnrollmentId: string | null
}
interface Person { id: string, fullName: string }
interface Stage { id: string, nameUk: string, isEnabled: boolean, courseIds: string[] }

const rows = ref<Row[]>([])
const stateFilter = ref<OffboardingState | ''>('')
const onlyActive = ref(true)
const error = ref('')
const notice = ref('')
const busy = ref('')

const starting = ref(false)
const cancelling = ref<Row | null>(null)
const cancelReason = ref('')
const people = ref<Person[]>([])
const stage = ref<Stage | null>(null)
const form = reactive({ userId: '', reasonCode: 'own_wish' as OffboardingReason, reasonText: '', lastWorkingDay: new Date().toISOString().slice(0, 10), responsibleId: '', exitInterview: false })

async function load() {
  error.value = ''
  try {
    rows.value = await api<Row[]>('/offboarding', {
      query: { ...(stateFilter.value ? { state: stateFilter.value } : {}), ...(onlyActive.value && !stateFilter.value ? { active: 'true' } : {}) },
    })
  }
  catch (err) { error.value = apiErrorOf(err).message }
}
watch([stateFilter, onlyActive], load)
onMounted(load)

async function openStart() {
  starting.value = true
  error.value = ''
  people.value = await api<Person[]>('/people', { query: { limit: 100 } }).catch(() => [])
  stage.value = await api<Stage>('/offboarding/stage').catch(() => null)
}

async function start() {
  busy.value = 'start'
  error.value = ''
  try {
    await api('/offboarding', {
      method: 'POST',
      body: {
        userId: form.userId,
        reasonCode: form.reasonCode,
        ...(form.reasonCode === 'other' ? { reasonText: form.reasonText } : {}),
        lastWorkingDay: form.lastWorkingDay,
        courseIds: stage.value?.courseIds ?? [],
        responsibleId: form.responsibleId,
      },
    })
    notice.value = t('offboarding.started')
    starting.value = false
    await load()
  }
  catch (err) { error.value = apiErrorOf(err).message }
  finally { busy.value = '' }
}

async function act(row: Row, action: 'handover' | 'complete') {
  busy.value = row.id
  error.value = ''
  try {
    await api(`/offboarding/${row.id}/${action}`, { method: 'POST', body: action === 'complete' ? { confirm: true } : { done: true } })
    notice.value = t(`offboarding.done.${action}`)
    await load()
  }
  catch (err) { error.value = apiErrorOf(err).message }
  finally { busy.value = '' }
}

/** Отмена — с причиной (§10 `POST /offboarding/:id/cancel {reason_text}`), отдельным диалогом. */
async function cancelCase() {
  const row = cancelling.value
  if (!row) return
  busy.value = row.id
  error.value = ''
  try {
    await api(`/offboarding/${row.id}/cancel`, { method: 'POST', body: { reasonText: cancelReason.value } })
    notice.value = t('offboarding.done.cancel')
    cancelling.value = null
    cancelReason.value = ''
    await load()
  }
  catch (err) { error.value = apiErrorOf(err).message }
  finally { busy.value = '' }
}

const dateOf = (v: string | null) => v ? formatDate(new Date(v), { day: '2-digit', month: '2-digit', year: 'numeric' }) : '—'
const isActive = (s: OffboardingState) => s !== 'done' && s !== 'cancelled'
</script>

<template>
  <div>
    <PageHeader
      :title="t('offboarding.title')"
      :subtitle="t('offboarding.hint')"
      :crumbs="[{ label: t('admin.nav.people'), to: '/admin/people' }, { label: t('offboarding.title') }]"
    />

    <div class="filters">
      <label>{{ t('offboarding.col.state') }}
        <select v-model="stateFilter">
          <option value="">{{ t('offboarding.anyState') }}</option>
          <option v-for="s in OFFBOARDING_STATES" :key="s" :value="s">{{ t(`offboarding.state.${s}`) }}</option>
        </select>
      </label>
      <label class="check">
        <input v-model="onlyActive" type="checkbox" :disabled="!!stateFilter">
        {{ t('offboarding.onlyActive') }}
      </label>
      <button class="btn" type="button" @click="openStart">{{ t('offboarding.start') }}</button>
    </div>

    <p v-if="error" class="error" role="alert">{{ error }}</p>
    <p v-if="notice" class="notice" role="status">{{ notice }}</p>

    <div class="table-wrap">
      <table class="table">
        <thead>
          <tr>
            <th>{{ t('offboarding.col.person') }}</th>
            <th>{{ t('offboarding.col.reason') }}</th>
            <th>{{ t('offboarding.col.lastDay') }}</th>
            <th>{{ t('offboarding.col.state') }}</th>
            <th>{{ t('offboarding.col.responsible') }}</th>
            <th />
          </tr>
        </thead>
        <tbody>
          <tr v-for="r in rows" :key="r.id">
            <td>
              <NuxtLink :to="`/admin/people/${r.userId}`" class="link">{{ r.fullName }}</NuxtLink>
              <div v-if="r.positionName || r.locationName" class="sub">{{ [r.positionName, r.locationName].filter(Boolean).join(' · ') }}</div>
            </td>
            <td>
              {{ t(`offboarding.reason.${r.reasonCode}`) }}
              <div v-if="r.reasonText" class="sub">{{ r.reasonText }}</div>
            </td>
            <td class="nowrap">{{ dateOf(r.lastWorkingDay) }}</td>
            <td><span :class="['pill', isActive(r.state) ? 'pill-open' : 'pill-ok']">{{ t(`offboarding.state.${r.state}`) }}</span></td>
            <td>{{ r.responsibleName ?? '—' }}</td>
            <td class="actions">
              <button v-if="isActive(r.state) && !r.handoverDoneAt" class="btn small" type="button" :disabled="busy === r.id" @click="act(r, 'handover')">
                {{ t('offboarding.handover') }}
              </button>
              <button v-if="isActive(r.state) && hasScope('offboarding.complete')" class="btn small" type="button" :disabled="busy === r.id" @click="act(r, 'complete')">
                {{ t('offboarding.complete') }}
              </button>
              <button v-if="isActive(r.state)" class="btn small ghost" type="button" :disabled="busy === r.id" @click="cancelling = r; cancelReason = ''">
                {{ t('offboarding.cancel') }}
              </button>
            </td>
          </tr>
          <tr v-if="rows.length === 0">
            <td colspan="6" class="sub">{{ t('offboarding.empty') }}</td>
          </tr>
        </tbody>
      </table>
    </div>

    <div v-if="starting" class="overlay" @click.self="starting = false">
      <form class="modal" role="dialog" aria-modal="true" @submit.prevent="start">
        <h2>{{ t('offboarding.startTitle') }}</h2>
        <label>{{ t('offboarding.col.person') }}
          <select v-model="form.userId" required>
            <option value="" disabled>—</option>
            <option v-for="p in people" :key="p.id" :value="p.id">{{ p.fullName }}</option>
          </select>
        </label>
        <label>{{ t('offboarding.col.reason') }}
          <select v-model="form.reasonCode" required>
            <option v-for="r in OFFBOARDING_REASONS" :key="r" :value="r">{{ t(`offboarding.reason.${r}`) }}</option>
          </select>
        </label>
        <label v-if="form.reasonCode === 'other'">{{ t('offboarding.reasonText') }}
          <input v-model="form.reasonText" minlength="10" maxlength="500" required>
        </label>
        <label>{{ t('offboarding.col.lastDay') }}
          <input v-model="form.lastWorkingDay" type="date" required :aria-describedby="'lwd-hint'">
        </label>
        <p id="lwd-hint" class="sub">{{ t('offboarding.lastDayHint') }}</p>
        <label>{{ t('offboarding.col.responsible') }}
          <select v-model="form.responsibleId" required>
            <option value="" disabled>—</option>
            <option v-for="p in people" :key="p.id" :value="p.id">{{ p.fullName }}</option>
          </select>
        </label>
        <p v-if="stage" class="sub">{{ t('offboarding.stageCourses', { n: stage.courseIds.length }) }}</p>
        <div class="modal-actions">
          <button class="btn" type="submit" :disabled="busy === 'start'">{{ t('offboarding.start') }}</button>
          <button class="btn ghost" type="button" @click="starting = false">{{ t('common.cancel') }}</button>
        </div>
      </form>
    </div>

    <div v-if="cancelling" class="overlay" @click.self="cancelling = null">
      <form class="modal" role="dialog" aria-modal="true" @submit.prevent="cancelCase">
        <h2>{{ t('offboarding.cancelTitle') }}</h2>
        <p class="sub">{{ cancelling.fullName }} · {{ t('offboarding.cancelHint') }}</p>
        <label>{{ t('offboarding.cancelReason') }}
          <input v-model="cancelReason" minlength="3" maxlength="500" required>
        </label>
        <div class="modal-actions">
          <button class="btn" type="submit" :disabled="busy === cancelling.id">{{ t('offboarding.cancel') }}</button>
          <button class="btn ghost" type="button" @click="cancelling = null">{{ t('common.close') }}</button>
        </div>
      </form>
    </div>
  </div>
</template>

<style scoped>
.filters { display: flex; flex-wrap: wrap; gap: var(--space-2); align-items: end; margin-bottom: var(--space-3); }
.actions { display: flex; flex-wrap: wrap; gap: var(--space-1); }
.nowrap { white-space: nowrap; }
@media (max-width: 480px) {
  .filters { flex-direction: column; align-items: stretch; }
}
</style>
