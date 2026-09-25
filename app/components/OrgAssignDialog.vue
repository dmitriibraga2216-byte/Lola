<script setup lang="ts">
/**
 * «Прив'язати співробітника» (docs/v2/32 §6.2, критерий приёмки 1; PR-31).
 *
 * Автокомплит человека, «Основне підпорядкування» / «Сумісництво», роль в узле, дата начала.
 * Узел-посада на одного человека спрашивает «Зробити вузол іменним?» (`32` §3.2 [решение]).
 * Если у человека уже есть основное подчинение, сервер отвечает `409 primary_exists`, и диалог
 * задаёт вопрос эталона: «Перенести» — повтор с `transferPrimary`, «Додати як сумісництво» —
 * повтор без основного. Решения здесь не принимаются — только вопросы и повтор запроса.
 */
interface NodeRef { id: string, title: string, type: 'position' | 'employee', headcountPlanned: number }
interface Person { id: string, fullName: string }

const props = defineProps<{
  node: NodeRef
  /** Человек, выбранный в форме именного узла, — чтобы не искать его второй раз. */
  preset?: Person | null
  /** Подпись узла по id — для вопроса «вже має основне підпорядкування: {node}». */
  titleOf: (id: string) => string
}>()
const emit = defineEmits<{ close: [], done: [message: string] }>()

const { t } = useI18n()
const { api, apiRaw } = useApi()

const query = ref(props.preset?.fullName ?? '')
const found = ref<Person[]>([])
const person = ref<Person | null>(props.preset ?? null)
const busy = ref(false)
const error = ref('')
const conflictNode = ref('')
const dialog = ref<HTMLElement | null>(null)

/** Сегодня в поясе браузера — значение по умолчанию для `<input type="date">`. */
function today(): string {
  const d = new Date()
  return new Date(d.getTime() - d.getTimezoneOffset() * 60_000).toISOString().slice(0, 10)
}

const form = reactive({ isPrimary: true, roleInNode: 'holder' as 'holder' | 'acting' | 'deputy', startedAt: today(), makeNamed: false })
const asksNamed = computed(() => props.node.type === 'position' && props.node.headcountPlanned === 1)

let timer: ReturnType<typeof setTimeout> | undefined
watch(query, (v) => {
  clearTimeout(timer)
  if (person.value && v === person.value.fullName) return
  person.value = null
  if (v.trim().length < 2) {
    found.value = []
    return
  }
  timer = setTimeout(async () => {
    try { found.value = (await apiRaw<{ data: Person[] }>('/people', { query: { q: v.trim(), tab: 'active', limit: 8 } })).data }
    catch { found.value = [] }
  }, 300)
})

function pick(p: Person) {
  person.value = p
  query.value = p.fullName
  found.value = []
}

onMounted(() => dialog.value?.querySelector<HTMLElement>('input')?.focus())

async function submit(extra: { transferPrimary?: boolean, isPrimary?: boolean } = {}) {
  if (!person.value) return
  busy.value = true
  error.value = ''
  try {
    await api(`/org-structure/nodes/${props.node.id}/assignments`, {
      method: 'POST',
      body: {
        userId: person.value.id,
        isPrimary: extra.isPrimary ?? form.isPrimary,
        roleInNode: form.roleInNode,
        startedAt: form.startedAt || undefined,
        makeNamed: asksNamed.value ? form.makeNamed : undefined,
        transferPrimary: extra.transferPrimary,
      },
    })
    emit('done', t('orgStructure.assigned'))
  }
  catch (err) {
    const e = apiErrorOf(err)
    if (e.code === 'primary_exists') {
      conflictNode.value = props.titleOf(String(e.details?.detail ?? ''))
      return
    }
    const key = `orgStructure.err.${e.code}`
    error.value = t(key) === key ? e.message : t(key)
  }
  finally {
    busy.value = false
  }
}
</script>

<template>
  <div class="overlay" @click.self="emit('close')" @keydown.esc="emit('close')">
    <form ref="dialog" class="modal" role="dialog" aria-modal="true" aria-labelledby="assign-title" @submit.prevent="submit()">
      <h2 id="assign-title">{{ t('orgStructure.assignTitle', { node: node.title }) }}</h2>

      <label>{{ t('orgStructure.person') }}
        <input v-model="query" class="field" type="search" autocomplete="off" :placeholder="t('orgStructure.employeeHint')" :aria-describedby="'assign-found'">
      </label>
      <ul v-if="found.length" id="assign-found" class="found" :aria-label="t('orgStructure.person')">
        <li v-for="p in found" :key="p.id"><button type="button" class="pick" @click="pick(p)">{{ p.fullName }}</button></li>
      </ul>
      <p v-else-if="query.trim().length >= 2 && !person" class="sub">{{ t('orgStructure.noPeople') }}</p>

      <fieldset class="group">
        <legend>{{ t('orgStructure.subordination') }}</legend>
        <label class="check"><input v-model="form.isPrimary" type="radio" :value="true"> {{ t('orgStructure.primaryOption') }}</label>
        <label class="check"><input v-model="form.isPrimary" type="radio" :value="false"> {{ t('orgStructure.secondaryOption') }}</label>
      </fieldset>

      <label>{{ t('orgStructure.role') }}
        <select v-model="form.roleInNode" class="field">
          <option value="holder">{{ t('orgStructure.roleHolder') }}</option>
          <option value="acting">{{ t('orgStructure.roleActing') }}</option>
          <option value="deputy">{{ t('orgStructure.roleDeputy') }}</option>
        </select>
      </label>

      <label>{{ t('orgStructure.startedAt') }}
        <input v-model="form.startedAt" class="field" type="date">
      </label>

      <fieldset v-if="asksNamed" class="group">
        <legend>{{ t('orgStructure.makeNamed') }}</legend>
        <p class="sub">{{ t('orgStructure.makeNamedHint') }}</p>
        <label class="check"><input v-model="form.makeNamed" type="radio" :value="true"> {{ t('orgStructure.yes') }}</label>
        <label class="check"><input v-model="form.makeNamed" type="radio" :value="false"> {{ t('orgStructure.no') }}</label>
      </fieldset>

      <div v-if="conflictNode" class="note sun" role="alert">
        <p>{{ t('orgStructure.primaryExistsNode', { node: conflictNode }) }}</p>
        <div class="modal-actions">
          <button type="button" class="btn primary" :disabled="busy" @click="submit({ transferPrimary: true })">{{ t('orgStructure.transfer') }}</button>
          <button type="button" class="btn ghost" :disabled="busy" @click="submit({ isPrimary: false })">{{ t('orgStructure.asSecondary') }}</button>
        </div>
      </div>

      <p v-if="error" class="error-text" role="alert">{{ error }}</p>
      <div class="modal-actions">
        <button class="btn primary" type="submit" :disabled="busy || !person || !!conflictNode">{{ t('orgStructure.assignSubmit') }}</button>
        <button class="btn ghost" type="button" @click="emit('close')">{{ t('orgStructure.cancel') }}</button>
      </div>
    </form>
  </div>
</template>

<style scoped>
.overlay { position: fixed; inset: 0; background: color-mix(in srgb, var(--color-ink) 45%, transparent); display: grid; place-items: center; padding: var(--space-3); z-index: 30; overflow: auto; }
.modal { background: var(--color-bg-soft); border-radius: var(--radius-l); padding: var(--space-4); display: grid; gap: var(--space-3); width: min(480px, 100%); box-sizing: border-box; }
.modal h2 { margin: 0; font-weight: 900; overflow-wrap: anywhere; }
.modal label { display: grid; gap: var(--space-1); font-size: var(--font-size-body-s); color: var(--color-ink-muted); }
.modal .check { display: flex; align-items: center; gap: var(--space-2); color: var(--color-ink); }
.modal .sub { color: var(--color-ink-muted); font-size: var(--font-size-body-s); margin: 0; }
.group { border: 1px solid var(--color-bg-line); border-radius: var(--radius-s); padding: var(--space-2) var(--space-3); display: grid; gap: var(--space-2); margin: 0; }
.group legend { font-size: var(--font-size-body-s); color: var(--color-ink-muted); padding: 0 var(--space-1); }
.found { list-style: none; margin: 0; padding: 0; display: grid; gap: var(--space-1); max-height: 40vh; overflow: auto; }
.pick { font: inherit; width: 100%; text-align: left; border: 1px solid var(--color-bg-line); background: var(--color-bg); color: var(--color-ink); border-radius: var(--radius-s); padding: var(--space-2) var(--space-3); cursor: pointer; }
.pick:hover, .pick:focus-visible { border-color: var(--color-ink); }
.note p { margin: 0 0 var(--space-2); }
.modal-actions { display: flex; gap: var(--space-2); justify-content: flex-end; flex-wrap: wrap; }
</style>
