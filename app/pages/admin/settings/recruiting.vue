<script setup lang="ts">
/**
 * «Налаштування → Рекрутинг» (docs/v2/28-recruiting-candidates.md §7.5, §7.9).
 *
 * Тумблер вмикає модуль тенанту: до нього розділу «Кандидати» немає в меню, а ручки воронки
 * відповідають `403 candidates.disabled`. Два строки поруч — авто-архівація відхилених і строк
 * згоди на обробку ПД: обидва задають, коли система діє без людини, тому живуть на одному екрані.
 */
definePageMeta({ layout: 'admin', middleware: 'admin-scope', requiredScope: 'settings.tenant' })

const { t } = useI18n()
const { api } = useApi()
const { fetchMe } = useAuth()

interface Recruiting {
  enabled: boolean
  autoArchiveRejected: boolean
  archiveAfterDays: number
  consentMonths: number
  notifyRejected: boolean
  /** Авто-відправка Підсумку (docs/v2/30 §6.5, §7.15). */
  summaryAutoSend: { enabled: boolean, scoreKind: 'manual' | 'task' | 'ai' | 'recruiter', minScore: number | null, delayHours: number, skipRejected: boolean }
}

const SCORE_KINDS = ['manual', 'task', 'ai', 'recruiter'] as const

const form = ref<Recruiting | null>(null)
const error = ref('')
const notice = ref('')
const busy = ref(false)

async function load() {
  try { form.value = await api<Recruiting>('/settings/recruiting') }
  catch (err) { error.value = apiErrorOf(err).message }
}
onMounted(load)

async function save() {
  if (!form.value) return
  busy.value = true
  error.value = ''
  notice.value = ''
  try {
    // Порожнє поле числа v-model.number віддає рядком — поріг «не задано» це null, а не ''
    const auto = form.value.summaryAutoSend
    const minScore = typeof auto.minScore === 'number' ? auto.minScore : null
    form.value = await api<Recruiting>('/settings/recruiting', { method: 'PATCH', body: { ...form.value, summaryAutoSend: { ...auto, minScore } } })
    notice.value = t('recruitingSettings.saved')
    // Меню читает флаг из `/auth/me`: без обновления раздел «Кандидати» появится только
    // после перезагрузки страницы.
    await fetchMe()
  }
  catch (err) { error.value = apiErrorOf(err).message }
  finally { busy.value = false }
}
</script>

<template>
  <div>
    <PageHeader :title="t('recruitingSettings.title')" :subtitle="t('recruitingSettings.hint')" />

    <p v-if="error" class="error" role="alert">{{ error }}</p>
    <p v-if="notice" class="notice" role="status">{{ notice }}</p>

    <form v-if="form" class="panel form" @submit.prevent="save">
      <label class="row">
        <input v-model="form.enabled" type="checkbox">
        <span>{{ t('recruitingSettings.enabled') }}</span>
      </label>
      <p class="sub">{{ t('recruitingSettings.enabledHint') }}</p>

      <label class="row">
        <input v-model="form.autoArchiveRejected" type="checkbox">
        <span>{{ t('recruitingSettings.autoArchive') }}</span>
      </label>
      <label>{{ t('recruitingSettings.archiveAfterDays') }}
        <input v-model.number="form.archiveAfterDays" type="number" min="7" max="365" :disabled="!form.autoArchiveRejected">
      </label>

      <label>{{ t('recruitingSettings.consentMonths') }}
        <input v-model.number="form.consentMonths" type="number" min="1" max="24">
      </label>
      <p class="sub">{{ t('recruitingSettings.consentHint') }}</p>

      <label class="row">
        <input v-model="form.notifyRejected" type="checkbox">
        <span>{{ t('recruitingSettings.notifyRejected') }}</span>
      </label>

      <!-- Авто-відправка Підсумку (docs/v2/30 §6.5): поріг, обов'язкова ненульова затримка, скасування рекрутером -->
      <fieldset class="group">
        <legend>{{ t('recruitingSettings.autoSend.title') }}</legend>
        <label class="row">
          <input v-model="form.summaryAutoSend.enabled" type="checkbox">
          <span>{{ t('recruitingSettings.autoSend.enabled') }}</span>
        </label>
        <label>{{ t('recruitingSettings.autoSend.scoreKind') }}
          <select v-model="form.summaryAutoSend.scoreKind" :disabled="!form.summaryAutoSend.enabled">
            <option v-for="k in SCORE_KINDS" :key="k" :value="k">{{ t(`candidate.scoreKind.${k}`) }}</option>
          </select>
        </label>
        <label>{{ t('recruitingSettings.autoSend.minScore') }}
          <input v-model.number="form.summaryAutoSend.minScore" type="number" step="1" :disabled="!form.summaryAutoSend.enabled" :required="form.summaryAutoSend.enabled">
        </label>
        <label>{{ t('recruitingSettings.autoSend.delayHours') }}
          <input v-model.number="form.summaryAutoSend.delayHours" type="number" min="1" max="168" :disabled="!form.summaryAutoSend.enabled">
        </label>
        <label class="row">
          <input v-model="form.summaryAutoSend.skipRejected" type="checkbox" :disabled="!form.summaryAutoSend.enabled">
          <span>{{ t('recruitingSettings.autoSend.skipRejected') }}</span>
        </label>
        <p class="sub">{{ t('recruitingSettings.autoSend.hint') }}</p>
      </fieldset>

      <button class="btn" type="submit" :disabled="busy">{{ t('common.save') }}</button>
    </form>
  </div>
</template>

<style scoped>
.form { display: grid; gap: var(--space-3); max-width: 32rem; }
.row { display: flex; gap: var(--space-2); align-items: center; }
.group { display: grid; gap: var(--space-3); border: 1px solid var(--color-bg-line-soft); border-radius: var(--radius-s); padding: var(--space-3); margin: 0; }
.group legend { font-weight: 800; }
</style>
