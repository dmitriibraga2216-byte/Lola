<script setup lang="ts">
import { CONTENT_TYPES } from '#shared/enums'
import type { ContentType } from '#shared/enums'

/**
 * «Правила нарахування» (docs/21 §3.7, §7.5; docs/15 §14.3 «Нагороди»): скільки балів рейтингу і
 * бонусів магазину дає виконане завдання кожного типу, якщо в параметрах призначення своїх чисел
 * немає. Правила — налаштування тенанта (`settings.gamification`), зміни пишуться в audit_log.
 * Сторінка не гаситься разом з модулем «Бонуси і магазин»: бали рейтингу нараховуються і без нього.
 */
definePageMeta({ layout: 'admin', middleware: 'admin-scope', requiredScope: 'settings.tenant' })

const { t } = useI18n()
const { api } = useApi()

type Reward = { points: number, bonuses: number }
interface Rules { taskRewards: Record<ContentType, Reward>, defaults: Record<ContentType, Reward>, bonusesEnabled: boolean }

const rules = ref<Rules | null>(null)
const form = reactive({} as Record<ContentType, Reward>)
const error = ref('')
const notice = ref('')
const busy = ref(false)

function fill(r: Rules) {
  rules.value = r
  for (const ct of CONTENT_TYPES) form[ct] = { ...r.taskRewards[ct] }
}

onMounted(async () => {
  try { fill(await api<Rules>('/settings/rewards')) }
  catch (err) { error.value = apiErrorOf(err).message }
})

const dirty = computed(() => !!rules.value && CONTENT_TYPES.some(ct => form[ct]?.points !== rules.value!.taskRewards[ct].points || form[ct]?.bonuses !== rules.value!.taskRewards[ct].bonuses))

function resetDefaults() {
  if (!rules.value) return
  for (const ct of CONTENT_TYPES) form[ct] = { ...rules.value.defaults[ct] }
}

async function save() {
  if (!rules.value) return
  busy.value = true
  error.value = ''
  notice.value = ''
  // Лише змінені числа — сервер зливає патч з поточними правилами
  const taskRewards: Partial<Record<ContentType, Partial<Reward>>> = {}
  for (const ct of CONTENT_TYPES) {
    const before = rules.value.taskRewards[ct]
    const now = form[ct]!
    const patch: Partial<Reward> = {}
    if (now.points !== before.points) patch.points = Number(now.points)
    if (now.bonuses !== before.bonuses) patch.bonuses = Number(now.bonuses)
    if (Object.keys(patch).length) taskRewards[ct] = patch
  }
  try {
    fill(await api<Rules>('/settings/rewards', { method: 'PATCH', body: { taskRewards } }))
    notice.value = t('rewards.saved')
  }
  catch (err) { error.value = apiErrorOf(err).message }
  finally { busy.value = false }
}
</script>

<template>
  <div>
    <PageHeader :title="t('rewards.title')" :crumbs="[{ label: t('admin.section.learning') }, { label: t('shop.crumb') }]">
      <template #actions>
        <button type="button" class="btn ghost" :disabled="!rules" @click="resetDefaults">{{ t('rewards.reset') }}</button>
        <button type="button" class="btn primary" :disabled="busy || !dirty" @click="save">{{ t('common.save') }}</button>
      </template>
    </PageHeader>

    <p class="help lead">{{ t('rewards.hint') }}</p>
    <p v-if="rules && !rules.bonusesEnabled" class="note sun">{{ t('rewards.moduleOff') }}</p>
    <p v-if="error" class="note coral" role="alert">{{ error }}</p>
    <p v-if="notice" class="note teal" role="status">{{ notice }}</p>

    <div v-if="rules" class="table-wrap">
      <table class="table">
        <thead>
          <tr>
            <th>{{ t('rewards.col.type') }}</th>
            <th>{{ t('rewards.col.points') }}</th>
            <th>{{ t('rewards.col.bonuses') }}</th>
          </tr>
        </thead>
        <tbody>
          <tr v-for="ct in CONTENT_TYPES" :key="ct">
            <td><b>{{ t(`contentType.${ct}`) }}</b></td>
            <td>
              <input v-model.number="form[ct]!.points" class="field num-input" type="number" min="0" max="10000" step="1" :aria-label="`${t(`contentType.${ct}`)}: ${t('rewards.col.points')}`">
              <span class="sub">{{ t('rewards.default', { n: rules.defaults[ct].points }) }}</span>
            </td>
            <td>
              <input v-model.number="form[ct]!.bonuses" class="field num-input" type="number" min="0" max="10000" step="1" :aria-label="`${t(`contentType.${ct}`)}: ${t('rewards.col.bonuses')}`">
              <span class="sub">{{ t('rewards.default', { n: rules.defaults[ct].bonuses }) }}</span>
            </td>
          </tr>
        </tbody>
      </table>
    </div>
  </div>
</template>

<style scoped>
.lead { max-width: 820px; margin: 0 0 var(--space-3); }
.num-input { max-width: 140px; }
</style>
