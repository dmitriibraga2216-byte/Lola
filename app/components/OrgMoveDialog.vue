<script setup lang="ts">
/**
 * Подтверждение переноса ветки (docs/v2/32 §6.2, §7 п. 2; PR-31): «Перенести вузол «X» разом
 * з N підлеглими вузлами до «Y»?» с галочкой «Залишити підлеглі вузли на місці». Тот же диалог
 * открывают и перетаскивание, и поле «Батьківський вузол» формы — второй путь нужен клавиатуре.
 * Перенос больше 20 узлов сервер предваряет снимком `pre_bulk_move` — его можно откатить.
 */
const props = defineProps<{
  node: { id: string, title: string }
  /** `null` — в корень структуры. */
  target: { id: string, title: string } | null
  descendants: number
}>()
const emit = defineEmits<{ close: [], done: [message: string] }>()

const { t } = useI18n()
const { api } = useApi()
const keepChildren = ref(false)
const busy = ref(false)
const error = ref('')
const dialog = ref<HTMLElement | null>(null)

onMounted(() => dialog.value?.querySelector<HTMLElement>('button[type="submit"]')?.focus())

async function submit() {
  busy.value = true
  error.value = ''
  try {
    await api(`/org-structure/nodes/${props.node.id}/move`, { method: 'POST', body: { parentId: props.target?.id ?? null, keepChildren: keepChildren.value } })
    emit('done', t('orgStructure.moved'))
  }
  catch (err) {
    const e = apiErrorOf(err)
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
    <form ref="dialog" class="modal" role="dialog" aria-modal="true" aria-labelledby="move-title" @submit.prevent="submit">
      <h2 id="move-title">{{ t('orgStructure.moveTitle') }}</h2>
      <p>{{ target ? t('orgStructure.moveConfirm', { node: node.title, n: descendants, target: target.title }) : t('orgStructure.moveConfirmRoot', { node: node.title, n: descendants }) }}</p>
      <label v-if="descendants" class="check"><input v-model="keepChildren" type="checkbox"> {{ t('orgStructure.keepChildren') }}</label>
      <p v-if="error" class="error-text" role="alert">{{ error }}</p>
      <div class="modal-actions">
        <button class="btn primary" type="submit" :disabled="busy">{{ t('orgStructure.moveSubmit') }}</button>
        <button class="btn ghost" type="button" @click="emit('close')">{{ t('orgStructure.cancel') }}</button>
      </div>
    </form>
  </div>
</template>

<style scoped>
.overlay { position: fixed; inset: 0; background: color-mix(in srgb, var(--color-ink) 45%, transparent); display: grid; place-items: center; padding: var(--space-3); z-index: 30; overflow: auto; }
.modal { background: var(--color-bg-soft); border-radius: var(--radius-l); padding: var(--space-4); display: grid; gap: var(--space-3); width: min(480px, 100%); box-sizing: border-box; }
.modal h2 { margin: 0; font-weight: 900; }
.modal p { margin: 0; overflow-wrap: anywhere; }
.check { display: flex; align-items: center; gap: var(--space-2); }
.modal-actions { display: flex; gap: var(--space-2); justify-content: flex-end; flex-wrap: wrap; }
</style>
