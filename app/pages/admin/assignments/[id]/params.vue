<script setup lang="ts">
import { PARAM_KEYS_BY_CONTENT_TYPE } from '#shared/schemas/assignments'
import type { ContentType } from '#shared/enums'

/**
 * Параметры назначения по мокапу TaskParams (docs/15 §14.3): боковое меню из пяти групп —
 * Загальне · Термін виконання · Результат · Нагороди · Метод призначення, плюс «Нагадування» (Г-15.1).
 * Набор полей группы «Загальне» зависит от типа контента: показываем только ключи PARAM_KEYS_BY_CONTENT_TYPE.
 */
definePageMeta({ layout: 'admin', middleware: 'admin-scope', requiredScope: 'assignment.create' })

const { t } = useI18n()
const { api } = useApi()
const route = useRoute()
const id = route.params.id as string

type Group = 'general' | 'deadline' | 'result' | 'rewards' | 'method' | 'reminders'
const GROUPS: Group[] = ['general', 'deadline', 'result', 'rewards', 'method', 'reminders']
const group = ref<Group>('general')

interface ParamsData { contentType: ContentType, params: Record<string, unknown>, method: { viaCatalog: boolean, automationRuleId: string | null, useInDevPlans: boolean } }
interface Reminders { enabled: boolean, beforeDueDays: number[], onDueDate: boolean, afterDueEveryDays: number | null, afterDueMaxCount: number, escalateToManagerAfterDays: number | null, channel: string | null, notifyOnAssign: boolean }

const contentType = ref<ContentType>('course')
const title = ref('')
const p = reactive<Record<string, unknown>>({})
const method = reactive({ viaCatalog: false, automationRuleId: null as string | null, useInDevPlans: false })
const rem = reactive<Reminders & { beforeText: string }>({ enabled: true, beforeDueDays: [7, 3, 1], beforeText: '7, 3, 1', onDueDate: true, afterDueEveryDays: 3, afterDueMaxCount: 5, escalateToManagerAfterDays: 7, channel: null, notifyOnAssign: true })
const rules = ref<{ id: string, name: string }[]>([])
const scales = ref<{ id: string, name: string }[]>([])
const error = ref('')
const notice = ref('')
const busy = ref(false)

// Режимы «Необмежено | Обмежено» для спроб и часу
const attemptsLimited = ref(false)
const timeLimited = ref(false)
const timeMin = ref(30)
const attemptsN = ref(3)

const has = (key: string) => (PARAM_KEYS_BY_CONTENT_TYPE[contentType.value] as readonly string[]).includes(key)
const isTest = computed(() => contentType.value === 'test')

async function load() {
  try {
    const [d, r, card, rl, sc] = await Promise.all([
      api<ParamsData>(`/tasks/${id}/params`), api<Reminders>(`/tasks/${id}/reminders`), api<{ title: string }>(`/tasks/${id}`),
      api<{ id: string, name: string }[]>('/automation-rules').catch(() => []), api<{ id: string, name: string }[]>('/rating-scales').catch(() => []),
    ])
    contentType.value = d.contentType
    title.value = card.title
    Object.assign(p, d.params)
    Object.assign(method, d.method)
    Object.assign(rem, r, { beforeText: r.beforeDueDays.join(', ') })
    rules.value = rl
    scales.value = sc
    attemptsLimited.value = typeof p.attemptsAllowed === 'number' && p.attemptsAllowed > 0
    attemptsN.value = attemptsLimited.value ? Number(p.attemptsAllowed) : 3
    timeLimited.value = typeof p.timeLimitSec === 'number' && p.timeLimitSec > 0
    timeMin.value = timeLimited.value ? Math.round(Number(p.timeLimitSec) / 60) : 30
  }
  catch (err) { error.value = apiErrorOf(err).message }
}
onMounted(load)

function bool(key: string) { return computed({ get: () => !!p[key], set: v => { p[key] = v } }) }
const flags = Object.fromEntries(['trainingMode', 'allowOtherPages', 'showErrorProtocol', 'hideCorrectInProtocol', 'shuffleOptions', 'keepQuestionOrder', 'allowSkip', 'instantFeedback', 'manualNext', 'allowComments', 'notifyOnResult', 'strictOrder', 'allowEarlyFinish', 'fixResult'].map(k => [k, bool(k)]))

async function save() {
  busy.value = true
  error.value = ''
  notice.value = ''
  try {
    const body: Record<string, unknown> = {}
    for (const k of PARAM_KEYS_BY_CONTENT_TYPE[contentType.value]) if (p[k] !== undefined && p[k] !== '') body[k] = p[k]
    if (has('attemptsAllowed')) body.attemptsAllowed = attemptsLimited.value ? attemptsN.value : 0
    if (has('timeLimitSec')) body.timeLimitSec = timeLimited.value ? timeMin.value * 60 : null
    if (has('questionsMode') && p.questionsMode !== 'limited') body.questionsCount = null
    Object.assign(body, method)
    await api(`/tasks/${id}/params`, { method: 'PUT', body })
    const beforeDueDays = rem.beforeText.split(',').map(s => Number(s.trim())).filter(n => n > 0)
    await api(`/tasks/${id}/reminders`, { method: 'PUT', body: { enabled: rem.enabled, beforeDueDays, onDueDate: rem.onDueDate, afterDueEveryDays: rem.afterDueEveryDays || null, afterDueMaxCount: rem.afterDueMaxCount, escalateToManagerAfterDays: rem.escalateToManagerAfterDays ?? null, channel: rem.channel || null, notifyOnAssign: rem.notifyOnAssign } })
    notice.value = t('assign.p.saved')
  }
  catch (err) {
    const e = apiErrorOf(err)
    error.value = e.code === 'validation_failed' ? `${t('assign.p.invalid')}: ${e.message}` : e.message
  }
  finally { busy.value = false }
}
</script>

<template>
  <div>
    <PageHeader :title="t('assign.p.title')" :crumbs="[{ label: t('admin.section.learning') }, { label: t('admin.nav.assignments'), to: '/admin/assignments' }, { label: title, to: `/admin/assignments/${id}` }]">
      <template #actions>
        <NuxtLink :to="`/admin/assignments/${id}`" class="btn ghost">{{ t('assign.card.discard') }}</NuxtLink>
        <button class="btn primary" :disabled="busy" @click="save">{{ t('common.save') }}</button>
      </template>
    </PageHeader>
    <p v-if="error" class="error-text">{{ error }}</p>
    <p v-if="notice" class="note teal">{{ notice }}</p>

    <div class="layout">
      <nav class="side" role="tablist" aria-orientation="vertical">
        <button v-for="g in GROUPS" :key="g" role="tab" :aria-selected="group === g" :class="['side-item', { on: group === g }]" @click="group = g">{{ t(`assign.p.${g}`) }}</button>
      </nav>

      <div class="content">
        <p class="note sun">{{ t('assign.p.note') }}</p>

        <!-- Загальне -->
        <section v-show="group === 'general'" class="group">
          <template v-if="isTest">
            <div class="field-row">
              <span class="label">{{ t('assign.p.questionsMode') }}</span>
              <div class="segmented" role="radiogroup">
                <button v-for="m in ['all', 'one_per_group', 'limited']" :key="m" type="button" :class="{ on: (p.questionsMode ?? 'all') === m }" @click="p.questionsMode = m">{{ t(`assign.p.${m === 'all' ? 'qmAll' : m === 'one_per_group' ? 'qmOnePerGroup' : 'qmLimited'}`) }}</button>
              </div>
              <input v-if="p.questionsMode === 'limited'" v-model.number="p.questionsCount" class="field short" type="number" min="1" max="200" :aria-label="t('assign.p.questionsCount')">
            </div>
          </template>
          <div v-if="has('attemptsAllowed')" class="field-row">
            <span class="label">{{ t('assign.p.attempts') }}</span>
            <div class="segmented" role="radiogroup">
              <button type="button" :class="{ on: !attemptsLimited }" @click="attemptsLimited = false">{{ t('assign.p.unlimited') }}</button>
              <button type="button" :class="{ on: attemptsLimited }" @click="attemptsLimited = true">{{ t('assign.p.limited') }}</button>
            </div>
            <input v-if="attemptsLimited" v-model.number="attemptsN" class="field short" type="number" min="1" max="10" :aria-label="t('assign.p.attempts')">
          </div>
          <div v-if="isTest" class="field-row">
            <span class="label">{{ t('assign.p.timeLimit') }}</span>
            <div class="segmented" role="radiogroup">
              <button type="button" :class="{ on: !timeLimited }" @click="timeLimited = false">{{ t('assign.p.unlimited') }}</button>
              <button type="button" :class="{ on: timeLimited }" @click="timeLimited = true">{{ t('assign.p.limited') }}</button>
            </div>
            <label v-if="timeLimited" class="inline"><input v-model.number="timeMin" class="field short" type="number" min="1" max="240"> {{ t('assign.p.minutes') }}</label>
          </div>
          <template v-if="isTest">
            <label class="toggle"><input v-model="flags.trainingMode!.value" type="checkbox"><span>{{ t('assign.p.trainingMode') }}<span class="hint">{{ t('assign.p.trainingModeHint') }}</span></span></label>
            <label class="toggle"><input v-model="flags.allowOtherPages!.value" type="checkbox"><span>{{ t('assign.p.allowOtherPages') }}</span></label>
            <label class="toggle"><input v-model="flags.showErrorProtocol!.value" type="checkbox"><span>{{ t('assign.p.showErrorProtocol') }}</span></label>
            <label class="toggle"><input v-model="flags.hideCorrectInProtocol!.value" type="checkbox"><span>{{ t('assign.p.hideCorrectInProtocol') }}</span></label>
            <h3 class="sub-title">{{ t('assign.p.questions') }}</h3>
            <label class="toggle"><input v-model="flags.shuffleOptions!.value" type="checkbox"><span>{{ t('assign.p.shuffleOptions') }}</span></label>
            <label class="toggle"><input v-model="flags.keepQuestionOrder!.value" type="checkbox"><span>{{ t('assign.p.keepQuestionOrder') }}</span></label>
            <label class="toggle"><input v-model="flags.allowSkip!.value" type="checkbox"><span>{{ t('assign.p.allowSkip') }}</span></label>
            <label class="toggle"><input v-model="flags.instantFeedback!.value" type="checkbox"><span>{{ t('assign.p.instantFeedback') }}<span class="hint">{{ t('assign.p.instantFeedbackHint') }}</span></span></label>
            <label class="toggle"><input v-model="flags.manualNext!.value" type="checkbox"><span>{{ t('assign.p.manualNext') }}</span></label>
          </template>
          <label v-if="has('strictOrder')" class="toggle"><input v-model="flags.strictOrder!.value" type="checkbox"><span>{{ t('assign.p.strictOrder') }}</span></label>
          <label v-if="has('allowEarlyFinish')" class="toggle"><input v-model="flags.allowEarlyFinish!.value" type="checkbox"><span>{{ t('assign.p.allowEarlyFinish') }}</span></label>
          <label v-if="has('webinarMinWatchPct')" class="inline"><span class="label">{{ t('assign.p.webinarMinWatchPct') }}</span><input v-model.number="p.webinarMinWatchPct" class="field short" type="number" min="1" max="100"></label>
          <h3 class="sub-title">{{ t('assign.p.other') }}</h3>
          <label class="toggle"><input v-model="flags.allowComments!.value" type="checkbox"><span>{{ t('assign.p.allowComments') }}</span></label>
          <label class="toggle"><input v-model="flags.notifyOnResult!.value" type="checkbox"><span>{{ t('assign.p.notifyOnResult') }}</span></label>
        </section>

        <!-- Термін виконання -->
        <section v-show="group === 'deadline'" class="group">
          <div class="field-row">
            <span class="label">{{ t('assign.p.deadlineMode') }}</span>
            <div class="segmented" role="radiogroup">
              <button v-for="m in ['unlimited', 'days_from_assign', 'calendar']" :key="m" type="button" :class="{ on: (p.deadlineMode ?? 'unlimited') === m }" @click="p.deadlineMode = m">{{ t(`assign.p.${m === 'unlimited' ? 'dmUnlimited' : m === 'days_from_assign' ? 'dmDays' : 'dmCalendar'}`) }}</button>
            </div>
          </div>
          <div v-if="!isTest" class="field-row">
            <span class="label">{{ t('assign.p.timeLimit') }}</span>
            <div class="segmented" role="radiogroup">
              <button type="button" :class="{ on: !timeLimited }" @click="timeLimited = false">{{ t('assign.p.unlimited') }}</button>
              <button type="button" :class="{ on: timeLimited }" @click="timeLimited = true">{{ t('assign.p.limited') }}</button>
            </div>
            <label v-if="timeLimited" class="inline"><input v-model.number="timeMin" class="field short" type="number" min="1" max="240"> {{ t('assign.p.minutes') }}</label>
          </div>
        </section>

        <!-- Результат -->
        <section v-show="group === 'result'" class="group">
          <div class="field-row">
            <span class="label">{{ t('assign.p.resultSource') }}</span>
            <div class="segmented" role="radiogroup">
              <button type="button" :class="{ on: (p.resultSource ?? 'last') === 'last' }" @click="p.resultSource = 'last'">{{ t('assign.p.rsLast') }}</button>
              <button type="button" :class="{ on: p.resultSource === 'best' }" @click="p.resultSource = 'best'">{{ t('assign.p.rsBest') }}</button>
            </div>
          </div>
          <label class="inline"><span class="label">{{ t('assign.p.passScore') }}</span><input v-model.number="p.passScore" class="field short" type="number" min="1" max="100"><span class="help">{{ t('assign.p.passScoreHint') }}</span></label>
          <label class="toggle"><input v-model="flags.fixResult!.value" type="checkbox"><span>{{ t('assign.p.fixResult') }}</span></label>
          <label class="inline"><span class="label">{{ t('assign.p.scale') }}</span>
            <select v-model="p.scaleId" class="field"><option :value="null">{{ t('assign.p.noScale') }}</option><option v-for="s in scales" :key="s.id" :value="s.id">{{ s.name }}</option></select>
          </label>
        </section>

        <!-- Нагороди -->
        <section v-show="group === 'rewards'" class="group">
          <label class="inline"><span class="label">{{ t('assign.p.badge') }}</span><input v-model="p.badgeId" class="field" :placeholder="t('assign.p.none')"></label>
          <label class="inline"><span class="label">{{ t('assign.p.certificate') }}</span><input v-model="p.certificateId" class="field" :placeholder="t('assign.p.none')"></label>
          <label class="inline"><span class="label">{{ t('assign.p.points') }}</span><input v-model.number="p.points" class="field short" type="number" min="0" max="10000"><span class="help">{{ t('assign.p.pointsHint') }}</span></label>
          <label class="inline"><span class="label">{{ t('assign.p.bonuses') }}</span><input v-model.number="p.bonuses" class="field short" type="number" min="0" max="10000"><span class="help">{{ t('assign.p.bonusesHint') }}</span></label>
        </section>

        <!-- Метод призначення -->
        <section v-show="group === 'method'" class="group">
          <label class="toggle"><input v-model="method.viaCatalog" type="checkbox"><span>{{ t('assign.p.viaCatalog') }}</span></label>
          <label class="inline"><span class="label">{{ t('assign.p.automation') }} → {{ t('assign.p.rule') }}</span>
            <select v-model="method.automationRuleId" class="field"><option :value="null">{{ t('assign.p.noRule') }}</option><option v-for="r in rules" :key="r.id" :value="r.id">{{ r.name }}</option></select>
          </label>
          <label class="toggle"><input v-model="method.useInDevPlans" type="checkbox"><span>{{ t('assign.p.useInDevPlans') }}</span></label>
        </section>

        <!-- Нагадування (Г-15.1) -->
        <section v-show="group === 'reminders'" class="group">
          <label class="toggle"><input v-model="rem.enabled" type="checkbox"><span>{{ t('assign.p.remindersEnabled') }}</span></label>
          <template v-if="rem.enabled">
            <label class="inline"><span class="label">{{ t('assign.p.beforeDueDays') }}</span><input v-model="rem.beforeText" class="field short" placeholder="7, 3, 1"></label>
            <label class="toggle"><input v-model="rem.onDueDate" type="checkbox"><span>{{ t('assign.p.onDueDate') }}</span></label>
            <label class="inline"><span class="label">{{ t('assign.p.afterDueEveryDays') }}</span><input v-model.number="rem.afterDueEveryDays" class="field short" type="number" min="0" max="30"></label>
            <label class="inline"><span class="label">{{ t('assign.p.afterDueMaxCount') }}</span><input v-model.number="rem.afterDueMaxCount" class="field short" type="number" min="1" max="5"></label>
            <label class="inline"><span class="label">{{ t('assign.p.escalate') }}</span><input v-model.number="rem.escalateToManagerAfterDays" class="field short" type="number" min="0" max="30"></label>
            <label class="inline"><span class="label">{{ t('assign.p.channel') }}</span>
              <select v-model="rem.channel" class="field"><option :value="null">{{ t('assign.p.channelDefault') }}</option><option v-for="ch in ['telegram', 'sms', 'email']" :key="ch" :value="ch">{{ ch }}</option></select>
            </label>
            <label class="toggle"><input v-model="rem.notifyOnAssign" type="checkbox"><span>{{ t('assign.notifyOnAssign') }}</span></label>
          </template>
        </section>
      </div>
    </div>
  </div>
</template>

<style scoped>
.layout { display: grid; grid-template-columns: 220px 1fr; gap: var(--space-4); align-items: start; }
.side { display: grid; gap: var(--space-1); position: sticky; top: var(--space-4); }
.side-item { font: inherit; font-weight: 700; text-align: left; border: none; background: transparent; color: var(--color-ink-muted); padding: var(--space-2) var(--space-3); border-radius: var(--radius-s); cursor: pointer; }
.side-item.on { background: var(--color-ink); color: var(--color-bg); }
.side-item:focus-visible { outline: 2px solid var(--color-ink); }
.content { display: grid; gap: var(--space-3); }
.group { display: grid; gap: var(--space-3); background: var(--color-bg-soft); border: 1px solid var(--color-bg-line-soft); border-radius: var(--radius-m); padding: var(--space-4); }
.field-row { display: flex; flex-wrap: wrap; gap: var(--space-2) var(--space-3); align-items: center; }
.field-row .label { margin: 0; flex-basis: 100%; }
.short { width: 110px; }
.inline { display: grid; gap: var(--space-1); }
.sub-title { margin: var(--space-2) 0 0; font-size: 12px; letter-spacing: 0.06em; color: var(--color-ink-muted); }
@media (max-width: 720px) {
  .layout { grid-template-columns: 1fr; }
  .side { position: static; display: flex; flex-wrap: wrap; gap: var(--space-1); }
}
</style>
