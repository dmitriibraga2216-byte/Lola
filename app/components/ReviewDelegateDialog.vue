<script setup lang="ts">
/**
 * «Делегування перевірки» (docs/v2/37 §6.1) — одна работа или «Делегувати обрані» (§5.1, до 25).
 *
 * Список «Кому делегувати» приходит с сервера уже отфильтрованным (§7.2: без права оценки на
 * точке, отсутствующие и отключившие делегирование не показываются вовсе) — экран ничего не
 * решает сам (CLAUDE.md п. 3). Подсказка о нагрузке и жёлтая плашка перегрузки — предупреждение,
 * а не запрет: лимит — сигнал распределению (§12).
 */
import { REVIEW_DELEGATION_REASONS } from '#shared/enums'
import type { ReviewDelegationReason } from '#shared/enums'

const props = defineProps<{
  itemIds: string[]
  /** Срок проверки элемента — верхняя граница срока делегата (§6.1). Для пачки — самый ранний. */
  slaDueAt: string | null
}>()
const emit = defineEmits<{ close: [], done: [message: string] }>()

const { t } = useI18n()
const { api } = useApi()
const { formatDateTime } = useFormat()

interface Target { id: string, fullName: string, open: number, max: number, overloaded: boolean }

const targets = ref<Target[] | null>(null)
const busy = ref(false)
const error = ref('')
const form = reactive({ toUserId: '', reasonCode: 'workload' as ReviewDelegationReason, reasonText: '', dueAt: '', notify: true })

/** Значение для `<input type="datetime-local">` в часовом поясе браузера. */
function localInput(d: Date): string {
  const off = d.getTimezoneOffset() * 60_000
  return new Date(d.getTime() - off).toISOString().slice(0, 16)
}

const minDue = computed(() => localInput(new Date(Date.now() + 12 * 3_600_000)))
const maxDue = computed(() => props.slaDueAt ? localInput(new Date(props.slaDueAt)) : undefined)
const target = computed(() => targets.value?.find(x => x.id === form.toUserId) ?? null)
const bulk = computed(() => props.itemIds.length > 1)
const dialog = ref<HTMLElement | null>(null)

onMounted(async () => {
  // Срок по умолчанию — +24 часа, но не позже срока проверки (§6.1).
  const day = new Date(Date.now() + 24 * 3_600_000)
  const sla = props.slaDueAt ? new Date(props.slaDueAt) : null
  form.dueAt = localInput(sla && sla < day ? sla : day)
  try {
    targets.value = await api<Target[]>(`/review/items/${props.itemIds[0]}/delegate-targets`)
  }
  catch (err) {
    error.value = apiErrorOf(err).message
    targets.value = []
  }
  dialog.value?.querySelector<HTMLElement>('select, input')?.focus()
})

async function submit() {
  busy.value = true
  error.value = ''
  const body = {
    toUserId: form.toUserId,
    reasonCode: form.reasonCode,
    ...(form.reasonCode === 'other' ? { reasonText: form.reasonText } : {}),
    dueAt: new Date(form.dueAt).toISOString(),
    notify: form.notify,
  }
  try {
    if (bulk.value) {
      const r = await api<{ ok: string[], failed: { id: string, code: string, message: string }[] }>('/review/items/bulk-delegate', { method: 'POST', body: { ...body, itemIds: props.itemIds } })
      emit('done', t('reviewDelegate.bulkDone', { ok: r.ok.length, failed: r.failed.length }))
    }
    else {
      await api(`/review/items/${props.itemIds[0]}/delegate`, { method: 'POST', body })
      emit('done', t('reviewDelegate.done'))
    }
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
  <div class="overlay" @click.self="emit('close')" @keydown.esc="emit('close')">
    <form ref="dialog" class="modal" role="dialog" aria-modal="true" aria-labelledby="delegate-title" @submit.prevent="submit">
      <h2 id="delegate-title">{{ bulk ? t('reviewDelegate.titleBulk', { n: itemIds.length }) : t('reviewDelegate.title') }}</h2>

      <p v-if="targets && !targets.length" class="note sun">{{ t('reviewDelegate.noTargets') }}</p>
      <label v-else>{{ t('reviewDelegate.to') }}
        <select v-model="form.toUserId" class="field" required>
          <option value="" disabled>{{ t('reviewDelegate.choose') }}</option>
          <option v-for="p in targets ?? []" :key="p.id" :value="p.id">{{ p.fullName }}</option>
        </select>
      </label>
      <p v-if="target" class="sub">{{ t('reviewDelegate.load', { name: target.fullName, n: target.open, m: target.max }) }}</p>
      <p v-if="target?.overloaded" class="note sun" role="status">{{ t('reviewDelegate.overloaded') }}</p>

      <label>{{ t('reviewDelegate.reason') }}
        <select v-model="form.reasonCode" class="field" required>
          <option v-for="r in REVIEW_DELEGATION_REASONS" :key="r" :value="r">{{ t(`reviewDelegate.reasons.${r}`) }}</option>
        </select>
      </label>
      <label v-if="form.reasonCode === 'other'">{{ t('reviewDelegate.reasonText') }}
        <textarea v-model="form.reasonText" class="field" rows="2" minlength="10" maxlength="500" required :aria-describedby="'reason-hint'" />
        <span id="reason-hint" class="sub">{{ t('reviewDelegate.reasonTextHint') }}</span>
      </label>

      <label>{{ t('reviewDelegate.due') }}
        <input v-model="form.dueAt" class="field" type="datetime-local" :min="minDue" :max="maxDue" required :aria-describedby="'due-hint'">
        <span v-if="slaDueAt" id="due-hint" class="sub">{{ t('reviewDelegate.dueHint', { date: formatDateTime(slaDueAt) }) }}</span>
      </label>

      <label class="check">
        <input v-model="form.notify" type="checkbox">
        {{ t('reviewDelegate.notify') }}
      </label>

      <p v-if="error" class="error-text" role="alert">{{ error }}</p>
      <div class="modal-actions">
        <button class="btn primary" type="submit" :disabled="busy || !targets?.length">{{ t('reviewDelegate.submit') }}</button>
        <button class="btn ghost" type="button" @click="emit('close')">{{ t('reviewDelegate.cancel') }}</button>
      </div>
    </form>
  </div>
</template>

<style scoped>
.overlay { position: fixed; inset: 0; background: color-mix(in srgb, var(--color-ink) 45%, transparent); display: grid; place-items: center; padding: var(--space-3); z-index: 30; overflow: auto; }
.modal { background: var(--color-bg-soft); border-radius: var(--radius-l); padding: var(--space-4); display: grid; gap: var(--space-3); width: min(480px, 100%); box-sizing: border-box; }
.modal h2 { margin: 0; font-weight: 900; }
.modal label { display: grid; gap: var(--space-1); font-size: var(--font-size-body-s); color: var(--color-ink-muted); }
.modal .check { display: flex; align-items: center; gap: var(--space-2); color: var(--color-ink); }
.modal .sub { color: var(--color-ink-muted); font-size: var(--font-size-body-s); margin: 0; }
.modal-actions { display: flex; gap: var(--space-2); justify-content: flex-end; flex-wrap: wrap; }
</style>
