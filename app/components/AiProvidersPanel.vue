<script setup lang="ts">
/**
 * Профілі провайдерів ШІ — вкладка «Налаштування → Штучний інтелект» (docs/v2/30 §3.2, §5.6,
 * §7.7, §7.12; API — PR-27, `GET|POST /ai/providers`, `PUT /ai/providers/:id`).
 *
 * Профіль — одна роль (розшифровка, оцінка, підказка, підсумок, генерація, пошук). Ключ API —
 * лише на запис: екран бачить тільки «свій ключ збережено». Правила, що потребують інших рядків
 * (строк зберігання в розшифровки, ланцюжок запасних, коментар до регіону поза ЄС), перевіряє
 * сервер — екран показує його пояснення, як є. Запасний профіль — лише тієї ж ролі.
 */
import { AI_DATA_REGIONS, AI_DRIVERS, AI_PROVIDER_RETENTIONS, AI_PURPOSES } from '#shared/enums'
import type { AiDataRegion, AiDriver, AiProviderRetention, AiPurpose } from '#shared/enums'

interface Provider {
  id: string
  code: string
  name: string
  purpose: AiPurpose
  driver: AiDriver
  endpointUrl: string | null
  hasOwnKey: boolean
  modelName: string
  modelVersion: string | null
  params: { temperature?: number, maxTokens?: number }
  dataRegion: AiDataRegion
  providerRetention: AiProviderRetention
  maxLatencyMs: number
  isActive: boolean
  priority: number
  fallbackProviderId: string | null
  updatedAt: string
}

const { t } = useI18n()
const { api } = useApi()
const { formatDateTime } = useFormat()

const items = ref<Provider[]>([])
const error = ref('')
const notice = ref('')
const loading = ref(true)
/** `null` — форма закрита, `'new'` — новий профіль, інакше `id` профілю. */
const editing = ref<string | null>(null)

const blank = () => ({
  code: '', name: '', purpose: 'interview_score' as AiPurpose, driver: 'openai_compatible' as AiDriver, endpointUrl: '', apiKey: '', dropKey: false,
  modelName: '', modelVersion: '', temperature: '' as number | '', maxTokens: '' as number | '', dataRegion: 'eu' as AiDataRegion, regionComment: '',
  providerRetention: 'none' as AiProviderRetention, maxLatencySec: 30, isActive: true, priority: 100, fallbackProviderId: '',
})
const form = reactive({ ...blank(), error: '', busy: false })
const current = computed(() => items.value.find(p => p.id === editing.value) ?? null)

async function load() {
  loading.value = true
  error.value = ''
  try { items.value = (await api<{ items: Provider[] }>('/ai/providers')).items }
  catch (err) { error.value = apiErrorOf(err).message }
  finally { loading.value = false }
}
onMounted(load)

function open(p: Provider | null) {
  notice.value = ''
  Object.assign(form, blank(), { error: '', busy: false })
  if (p) {
    Object.assign(form, {
      code: p.code, name: p.name, purpose: p.purpose, driver: p.driver, endpointUrl: p.endpointUrl ?? '', modelName: p.modelName,
      modelVersion: p.modelVersion ?? '', temperature: p.params.temperature ?? '', maxTokens: p.params.maxTokens ?? '', dataRegion: p.dataRegion,
      providerRetention: p.providerRetention, maxLatencySec: Math.round(p.maxLatencyMs / 1000), isActive: p.isActive, priority: p.priority,
      fallbackProviderId: p.fallbackProviderId ?? '',
    })
  }
  editing.value = p?.id ?? 'new'
}

/** Запасний — лише тієї ж ролі й не сам профіль (сервер перевіряє ще й коло та глибину). */
const fallbacks = computed(() => items.value.filter(p => p.purpose === form.purpose && p.id !== editing.value))
const nameOf = (id: string | null) => items.value.find(p => p.id === id)?.name ?? '—'
const regionChanged = computed(() => form.dataRegion === 'other' && current.value?.dataRegion !== 'other')

async function save() {
  form.error = ''
  form.busy = true
  const params: Record<string, number> = {}
  if (form.temperature !== '') params.temperature = Number(form.temperature)
  if (form.maxTokens !== '') params.maxTokens = Number(form.maxTokens)
  const body: Record<string, unknown> = {
    name: form.name, purpose: form.purpose, driver: form.driver,
    endpointUrl: form.driver === 'stub' ? null : (form.endpointUrl.trim() || null),
    modelName: form.modelName, modelVersion: form.modelVersion.trim() || null, params,
    dataRegion: form.dataRegion, providerRetention: form.providerRetention, maxLatencyMs: Number(form.maxLatencySec) * 1000,
    isActive: form.isActive, priority: Number(form.priority), fallbackProviderId: form.fallbackProviderId || null,
  }
  if (form.apiKey.trim()) body.apiKey = form.apiKey.trim()
  else if (form.dropKey) body.apiKey = null
  if (regionChanged.value || form.regionComment.trim()) body.regionComment = form.regionComment
  try {
    if (editing.value === 'new') await api('/ai/providers', { method: 'POST', body: { ...body, code: form.code } })
    else await api(`/ai/providers/${editing.value}`, { method: 'PUT', body })
    editing.value = null
    notice.value = t('aiSettings.providers.saved')
    await load()
  }
  catch (err) { form.error = apiErrorOf(err).message }
  finally { form.busy = false }
}
</script>

<template>
  <section class="panel stack">
    <div class="row between">
      <div>
        <h2 class="h2">{{ t('aiSettings.providers.title') }}</h2>
        <p class="sub">{{ t('aiSettings.providers.hint') }}</p>
      </div>
      <button v-if="editing !== 'new'" class="btn ghost small" type="button" @click="open(null)">{{ t('aiSettings.providers.add') }}</button>
    </div>

    <p v-if="error" class="note coral" role="alert">{{ error }}</p>
    <p v-if="notice" class="note teal" role="status">{{ notice }}</p>
    <p v-if="loading" class="muted">{{ t('aiSettings.loading') }}</p>

    <form v-if="editing" class="card form" @submit.prevent="save">
      <strong>{{ editing === 'new' ? t('aiSettings.providers.newTitle') : t('aiSettings.providers.editTitle', { name: current?.name ?? '' }) }}</strong>
      <div class="grid">
        <label v-if="editing === 'new'">{{ t('aiSettings.providers.f.code') }}
          <input v-model="form.code" class="field" required pattern="[a-z0-9][a-z0-9_\-]{1,39}" autocomplete="off">
          <span class="sub">{{ t('aiSettings.providers.f.codeHint') }}</span>
        </label>
        <label>{{ t('aiSettings.providers.f.name') }}
          <input v-model="form.name" class="field" required minlength="2" maxlength="120">
        </label>
        <label>{{ t('aiSettings.providers.f.purpose') }}
          <select v-model="form.purpose" class="field">
            <option v-for="p in AI_PURPOSES" :key="p" :value="p">{{ t(`aiSettings.purpose.${p}`) }}</option>
          </select>
        </label>
        <label>{{ t('aiSettings.providers.f.driver') }}
          <select v-model="form.driver" class="field">
            <option v-for="d in AI_DRIVERS" :key="d" :value="d">{{ t(`aiSettings.driver.${d}`) }}</option>
          </select>
        </label>
        <label v-if="form.driver !== 'stub'" class="wide">{{ t('aiSettings.providers.f.endpoint') }}
          <input v-model="form.endpointUrl" class="field" type="url" inputmode="url" placeholder="https://" maxlength="500" required>
        </label>
        <label v-if="form.driver !== 'stub'" class="wide">{{ t('aiSettings.providers.f.apiKey') }}
          <input v-model="form.apiKey" class="field" type="password" autocomplete="new-password" maxlength="500" :placeholder="current?.hasOwnKey ? t('aiSettings.providers.f.keySaved') : t('aiSettings.providers.f.keyPlatform')">
        </label>
        <label v-if="current?.hasOwnKey && !form.apiKey" class="check wide">
          <input v-model="form.dropKey" type="checkbox">
          <span>{{ t('aiSettings.providers.f.dropKey') }}</span>
        </label>
        <label>{{ t('aiSettings.providers.f.model') }}
          <input v-model="form.modelName" class="field" required maxlength="120">
        </label>
        <label>{{ t('aiSettings.providers.f.modelVersion') }}
          <input v-model="form.modelVersion" class="field" maxlength="60">
        </label>
        <label>{{ t('aiSettings.providers.f.temperature') }}
          <input v-model.number="form.temperature" class="field" type="number" min="0" max="2" step="0.1">
        </label>
        <label>{{ t('aiSettings.providers.f.maxTokens') }}
          <input v-model.number="form.maxTokens" class="field" type="number" min="1" max="32000" step="1">
        </label>
        <label>{{ t('aiSettings.providers.f.region') }}
          <select v-model="form.dataRegion" class="field">
            <option v-for="r in AI_DATA_REGIONS" :key="r" :value="r">{{ t(`aiSettings.region.${r}`) }}</option>
          </select>
        </label>
        <label v-if="form.dataRegion === 'other'" class="wide">{{ t('aiSettings.providers.f.regionComment') }}
          <textarea v-model="form.regionComment" class="field" rows="2" maxlength="500" :required="regionChanged" :minlength="regionChanged ? 10 : undefined" />
          <span class="sub">{{ t('aiSettings.providers.f.regionCommentHint') }}</span>
        </label>
        <label>{{ t('aiSettings.providers.f.retention') }}
          <select v-model="form.providerRetention" class="field">
            <option v-for="r in AI_PROVIDER_RETENTIONS" :key="r" :value="r">{{ t(`aiSettings.retention.${r}`) }}</option>
          </select>
          <span v-if="form.purpose === 'transcribe'" class="sub">{{ t('aiSettings.providers.f.retentionTranscribe') }}</span>
        </label>
        <label>{{ t('aiSettings.providers.f.latency') }}
          <input v-model.number="form.maxLatencySec" class="field" type="number" min="1" max="300" step="1" required>
        </label>
        <label>{{ t('aiSettings.providers.f.priority') }}
          <input v-model.number="form.priority" class="field" type="number" min="0" max="10000" step="1" required>
          <span class="sub">{{ t('aiSettings.providers.f.priorityHint') }}</span>
        </label>
        <label>{{ t('aiSettings.providers.f.fallback') }}
          <select v-model="form.fallbackProviderId" class="field">
            <option value="">{{ t('aiSettings.providers.f.noFallback') }}</option>
            <option v-for="p in fallbacks" :key="p.id" :value="p.id">{{ p.name }}</option>
          </select>
        </label>
        <label class="check">
          <input v-model="form.isActive" type="checkbox">
          <span>{{ t('aiSettings.providers.f.active') }}</span>
        </label>
      </div>
      <p v-if="form.error" class="note coral" role="alert">{{ form.error }}</p>
      <div class="row">
        <button class="btn primary" type="submit" :disabled="form.busy">{{ t('aiSettings.providers.save') }}</button>
        <button class="btn ghost" type="button" :disabled="form.busy" @click="editing = null">{{ t('aiSettings.providers.cancel') }}</button>
      </div>
    </form>

    <p v-if="!loading && !items.length" class="muted">{{ t('aiSettings.providers.empty') }}</p>
    <ul class="list">
      <li v-for="p in items" :key="p.id" class="card item">
        <div class="row between">
          <div>
            <b>{{ p.name }}</b>
            <span class="sub"> · {{ p.code }}</span>
          </div>
          <div class="row">
            <span :class="['badge', p.isActive ? 'teal' : '']">{{ p.isActive ? t('aiSettings.providers.active') : t('aiSettings.providers.inactive') }}</span>
            <button class="btn ghost small" type="button" :aria-label="t('aiSettings.providers.editAria', { name: p.name })" @click="open(p)">{{ t('aiSettings.providers.edit') }}</button>
          </div>
        </div>
        <dl class="meta">
          <div><dt>{{ t('aiSettings.providers.f.purpose') }}</dt><dd>{{ t(`aiSettings.purpose.${p.purpose}`) }}</dd></div>
          <div><dt>{{ t('aiSettings.providers.f.driver') }}</dt><dd>{{ t(`aiSettings.driver.${p.driver}`) }}</dd></div>
          <div><dt>{{ t('aiSettings.providers.f.model') }}</dt><dd>{{ p.modelName }}<template v-if="p.modelVersion"> {{ p.modelVersion }}</template></dd></div>
          <div><dt>{{ t('aiSettings.providers.f.region') }}</dt><dd>{{ t(`aiSettings.region.${p.dataRegion}`) }}</dd></div>
          <div><dt>{{ t('aiSettings.providers.f.retention') }}</dt><dd>{{ t(`aiSettings.retention.${p.providerRetention}`) }}</dd></div>
          <div><dt>{{ t('aiSettings.providers.f.key') }}</dt><dd>{{ p.driver === 'stub' ? '—' : p.hasOwnKey ? t('aiSettings.providers.ownKey') : t('aiSettings.providers.platformKey') }}</dd></div>
          <div><dt>{{ t('aiSettings.providers.f.priority') }}</dt><dd>{{ p.priority }}</dd></div>
          <div><dt>{{ t('aiSettings.providers.f.fallback') }}</dt><dd>{{ nameOf(p.fallbackProviderId) }}</dd></div>
        </dl>
        <p v-if="p.driver === 'stub'" class="sub">{{ t('aiSettings.providers.stubHint') }}</p>
        <p class="sub">{{ t('aiSettings.providers.updated', { date: formatDateTime(p.updatedAt) }) }}</p>
      </li>
    </ul>
  </section>
</template>

<style scoped>
.stack { display: grid; gap: var(--space-3); }
.row { display: flex; gap: var(--space-2); align-items: center; flex-wrap: wrap; }
.between { justify-content: space-between; }
.h2 { margin: 0 0 var(--space-1); font-size: var(--font-size-body); font-weight: 900; }
.sub { margin: 0; color: var(--color-ink-muted); font-size: var(--font-size-body-s); }
.form { display: grid; gap: var(--space-3); }
.grid { display: grid; gap: var(--space-3); grid-template-columns: repeat(auto-fill, minmax(min(100%, 14rem), 1fr)); }
.grid label { display: grid; gap: var(--space-1); font-size: var(--font-size-body-s); font-weight: 700; }
.grid .wide { grid-column: 1 / -1; }
.grid .check { display: flex; align-items: center; gap: var(--space-2); font-weight: 400; }
.list { list-style: none; margin: 0; padding: 0; display: grid; gap: var(--space-3); }
.item { display: grid; gap: var(--space-2); }
.meta { display: grid; grid-template-columns: repeat(auto-fill, minmax(min(100%, 10rem), 1fr)); gap: var(--space-2); margin: 0; }
.meta dt { font-size: var(--font-size-body-s); color: var(--color-ink-muted); }
.meta dd { margin: 0; overflow-wrap: anywhere; }
</style>
