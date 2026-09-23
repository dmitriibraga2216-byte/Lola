<script setup lang="ts">
/**
 * Налаштування етапів життєвого циклу (docs/v2/33-lifecycle.md §5.2).
 *
 * Код — сірим, нередагований. Назва, іконка, колір, порядок, «Увімкнено» і норма часу —
 * редагуються. Можливості етапу показані **тільки для читання** (§2: набір задає платформа):
 * значки з підписами і поруч текст «Щоб змінити — зверніться до підтримки».
 */
import { STAGE_CAPABILITIES } from '#shared/enums'
import type { StageCapability } from '#shared/enums'

definePageMeta({ layout: 'admin', middleware: 'admin-scope', requiredScope: 'lifecycle.view' })
const { t } = useI18n()
const { api } = useApi()

interface Stage {
  id: string
  code: string
  nameUk: string
  nameEn: string | null
  icon: string | null
  color: 'ink' | 'sun' | 'teal' | 'coral'
  sort: number
  isEnabled: boolean
  expectedDays: number | null
  capabilities: Partial<Record<StageCapability, boolean>>
  coursesCount: number
}

const stages = ref<Stage[]>([])
const error = ref('')
const savingId = ref('')

async function load() { stages.value = await api<Stage[]>('/settings/lifecycle-stages') }
onMounted(load)

/** Патч одного поля: сервер — источник правды, ответ перезаписывает строку. */
async function save(s: Stage, patch: Record<string, unknown>) {
  error.value = ''
  savingId.value = s.id
  try {
    const updated = await api<Stage>(`/settings/lifecycle-stages/${s.id}`, { method: 'PATCH', body: patch })
    const i = stages.value.findIndex(x => x.id === s.id)
    if (i >= 0) stages.value[i] = updated
  }
  catch (err) {
    error.value = apiErrorOf(err).message
    await load()
  }
  finally { savingId.value = '' }
}

const colors = ['ink', 'sun', 'teal', 'coral'] as const
const capsOf = (s: Stage) => STAGE_CAPABILITIES.filter(c => s.capabilities[c] === true)
</script>

<template>
  <div>
    <PageHeader
      :title="t('settings.lifecycle.title')"
      :crumbs="[{ label: t('admin.section.settings') }, { label: t('settings.lifecycle.title') }]"
    />
    <p class="help">{{ t('settings.lifecycle.hint') }}</p>
    <p v-if="error" class="error-text" role="alert">{{ error }}</p>

    <p v-if="!stages.length" class="muted">{{ t('settings.lifecycle.empty') }}</p>
    <div class="cards">
      <article v-for="s in stages" :key="s.id" class="card stage" :class="{ off: !s.isEnabled }">
        <header>
          <span class="code">{{ s.code }}</span>
          <b v-if="!s.isEnabled" class="badge muted">{{ t('settings.lifecycle.disabledBadge') }}</b>
          <span class="spacer" />
          <span class="muted">{{ t('settings.lifecycle.coursesCount') }}: {{ s.coursesCount }}</span>
        </header>

        <div class="fields">
          <label class="label" :for="`nm-${s.id}`">{{ t('settings.lifecycle.name') }}</label>
          <input
            :id="`nm-${s.id}`" v-model="s.nameUk" class="field" maxlength="60"
            :disabled="savingId === s.id" @change="save(s, { nameUk: s.nameUk })"
          >

          <label class="label" :for="`sr-${s.id}`">{{ t('settings.lifecycle.sort') }}</label>
          <input
            :id="`sr-${s.id}`" v-model.number="s.sort" class="field n" type="number" min="0" max="99"
            :disabled="savingId === s.id" @change="save(s, { sort: s.sort })"
          >

          <label class="label" :for="`ed-${s.id}`">{{ t('settings.lifecycle.expectedDays') }}</label>
          <input
            :id="`ed-${s.id}`" v-model.number="s.expectedDays" class="field n" type="number" min="1" max="365"
            :disabled="savingId === s.id" :aria-describedby="`edh-${s.id}`"
            @change="save(s, { expectedDays: s.expectedDays === null || Number.isNaN(s.expectedDays) ? null : s.expectedDays })"
          >
          <p :id="`edh-${s.id}`" class="help span">{{ t('settings.lifecycle.expectedDaysHint') }}</p>

          <p class="label">{{ t('settings.lifecycle.color') }}</p>
          <div class="segmented">
            <button
              v-for="c in colors" :key="c" type="button" :class="{ on: s.color === c }"
              :disabled="savingId === s.id" @click="s.color = c; save(s, { color: c })"
            >
              {{ t(`settings.space.accents.${c}`) }}
            </button>
          </div>

          <p class="label">{{ t('settings.lifecycle.enabled') }}</p>
          <label class="toggle">
            <input
              v-model="s.isEnabled" type="checkbox" :disabled="savingId === s.id"
              @change="save(s, { isEnabled: s.isEnabled })"
            >
            <span>{{ t('settings.lifecycle.enabled') }}</span>
          </label>
        </div>

        <p class="label top">{{ t('settings.lifecycle.capabilities') }}</p>
        <ul class="caps">
          <li v-for="c in capsOf(s)" :key="c" class="badge">{{ t(`settings.lifecycle.cap.${c}`) }}</li>
        </ul>
        <p class="help">{{ t('settings.lifecycle.capabilitiesReadonly') }}</p>
      </article>
    </div>
  </div>
</template>

<style scoped>
.cards { display: grid; grid-template-columns: repeat(auto-fill, minmax(320px, 1fr)); gap: var(--space-3); margin-top: var(--space-4); }
.stage header { display: flex; gap: var(--space-2); align-items: center; margin-bottom: var(--space-2); flex-wrap: wrap; }
.stage.off { opacity: 0.6; }
.code { color: var(--color-ink-muted); letter-spacing: 0.04em; }
.spacer { flex: 1; }
.fields { display: grid; grid-template-columns: minmax(0, 1fr) minmax(0, 1fr); gap: var(--space-2); align-items: center; }
.fields .span { grid-column: 1 / -1; }
.top { margin-top: var(--space-3); }
.caps { list-style: none; margin: 0 0 var(--space-2); padding: 0; display: flex; flex-wrap: wrap; gap: var(--space-1); }
@media (max-width: 480px) { .fields { grid-template-columns: 1fr; } }
</style>
