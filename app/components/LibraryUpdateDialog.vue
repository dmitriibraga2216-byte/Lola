<script setup lang="ts">
import type { LibraryCompare } from './LibraryDiff.vue'

/**
 * «Оновити до останньої версії» (docs/v2/31 §5.5, §7.3, критерий 2): заголовок «Оновити «…» з
 * v2 до v4», changelog каждой пропущенной версии, поблочный diff закреплённой и последней
 * (добавленные — бирюзой, удалённые — кораллом, изменённые — «було / стало»), строка
 * последствий и «Оновити» / «Скасувати». Всё посчитано сервером (`GET …/update-preview`):
 * диалог только показывает и подтверждает (CLAUDE.md п. 3).
 */
const props = defineProps<{ usageId: string }>()
const emit = defineEmits<{ close: [], done: [version: number] }>()
const { t } = useI18n()
const { api } = useApi()

interface VersionRef { id: string, version: number, publishedAt: string, changelog: string, isHotfix: boolean, title: string }
interface Preview {
  alreadyStarted: number
  compare: LibraryCompare & {
    moduleTitle: string
    from: VersionRef
    to: VersionRef
  }
}

const preview = ref<Preview | null>(null)
const error = ref('')
const busy = ref(false)
const dialog = ref<HTMLElement | null>(null)

onMounted(async () => {
  try {
    preview.value = await api<Preview>(`/library/usages/${props.usageId}/update-preview`)
  }
  catch (err) {
    error.value = apiErrorOf(err).message
  }
  nextTick(() => dialog.value?.querySelector<HTMLElement>('button.primary, button')?.focus())
})

async function confirm() {
  if (!preview.value) return
  busy.value = true
  error.value = ''
  try {
    await api(`/library/usages/${props.usageId}/update-version`, { method: 'POST', body: { toVersion: preview.value.compare.to.version } })
    emit('done', preview.value.compare.to.version)
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
  <div class="overlay" @click.self="emit('close')" @keydown.esc.stop="emit('close')">
    <section ref="dialog" class="dialog card" role="dialog" aria-modal="true" aria-labelledby="lib-update-title" data-testid="library-update-dialog">
      <template v-if="preview">
        <h2 id="lib-update-title" class="panel-title">
          {{ t('library.update.title', { title: preview.compare.moduleTitle, from: preview.compare.from.version, to: preview.compare.to.version }) }}
        </h2>

        <LibraryDiff :compare="preview.compare" />

        <p class="note sun" role="status">
          {{ preview.alreadyStarted > 0
            ? t('library.update.consequence', { n: preview.alreadyStarted, from: preview.compare.from.version })
            : t('library.update.noOneStarted', { to: preview.compare.to.version }) }}
        </p>
      </template>
      <p v-else-if="!error" class="muted" aria-live="polite">{{ t('common.loading') }}</p>

      <p v-if="error" class="error-text" role="alert">{{ error }}</p>
      <div class="actions">
        <button class="btn primary" type="button" :disabled="!preview || busy" data-testid="library-update-confirm" @click="confirm">{{ t('library.update.confirm') }}</button>
        <button class="btn ghost" type="button" @click="emit('close')">{{ t('common.cancel') }}</button>
      </div>
    </section>
  </div>
</template>

<style scoped>
.overlay { position: fixed; inset: 0; background: color-mix(in srgb, var(--color-ink) 45%, transparent); display: grid; place-items: center; padding: var(--space-3); z-index: 30; overflow: auto; }
.dialog { width: min(640px, 100%); box-sizing: border-box; display: grid; gap: var(--space-3); background: var(--color-bg-soft); max-height: calc(100vh - var(--space-6)); overflow: auto; }
.dialog .panel-title { margin: 0; }
.actions { display: flex; gap: var(--space-2); justify-content: flex-end; flex-wrap: wrap; }
</style>
