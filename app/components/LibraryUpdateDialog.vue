<script setup lang="ts">
import type { ContentBlock } from '#shared/schemas/content'

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
const { formatShortDate } = useFormat()

interface VersionRef { id: string, version: number, publishedAt: string, changelog: string, isHotfix: boolean, title: string }
interface Preview {
  alreadyStarted: number
  compare: {
    moduleTitle: string
    from: VersionRef
    to: VersionRef
    changelogs: VersionRef[]
    diff: { added: string[], removed: string[], changed: string[] }
    before: ContentBlock[]
    after: ContentBlock[]
  }
}

const preview = ref<Preview | null>(null)
const error = ref('')
const busy = ref(false)
const dialog = ref<HTMLElement | null>(null)

const byId = (blocks: ContentBlock[]) => new Map(blocks.map(b => [b.id, b]))
const blocks = computed(() => {
  const p = preview.value
  if (!p) return { added: [], removed: [], changed: [] }
  const before = byId(p.compare.before), after = byId(p.compare.after)
  return {
    added: p.compare.diff.added.map(id => after.get(id)).filter((b): b is ContentBlock => !!b),
    removed: p.compare.diff.removed.map(id => before.get(id)).filter((b): b is ContentBlock => !!b),
    changed: p.compare.diff.changed.map(id => ({ id, before: before.get(id), after: after.get(id) }))
      .filter((c): c is { id: string, before: ContentBlock, after: ContentBlock } => !!c.before && !!c.after),
  }
})
const noBlockChanges = computed(() => !blocks.value.added.length && !blocks.value.removed.length && !blocks.value.changed.length)

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

        <h3 class="sub-title">{{ t('library.update.changes') }}</h3>
        <ol class="changelog">
          <li v-for="v in preview.compare.changelogs" :key="v.id">
            <strong>v{{ v.version }}</strong> · {{ formatShortDate(new Date(v.publishedAt)) }}
            <span v-if="v.isHotfix" class="badge coral">{{ t('library.update.hotfix') }}</span>
            <p class="log">{{ v.changelog }}</p>
          </li>
        </ol>

        <h3 class="sub-title">{{ t('library.update.diff') }}</h3>
        <p v-if="noBlockChanges" class="muted">{{ t('library.update.noBlockChanges') }}</p>
        <div v-for="b in blocks.added" :key="`a-${b.id}`" class="block added">
          <span class="tag">{{ t('library.update.added') }} · {{ t(`blocks.${b.type}`) }}</span>
          <LessonBlocks :blocks="[b]" :blocks-state="{}" readonly />
        </div>
        <div v-for="b in blocks.removed" :key="`r-${b.id}`" class="block removed">
          <span class="tag">{{ t('library.update.removed') }} · {{ t(`blocks.${b.type}`) }}</span>
          <LessonBlocks :blocks="[b]" :blocks-state="{}" readonly />
        </div>
        <details v-for="c in blocks.changed" :key="`c-${c.id}`" class="block changed">
          <summary class="tag">{{ t('library.update.changed') }} · {{ t(`blocks.${c.after.type}`) }} — {{ t('library.update.beforeAfter') }}</summary>
          <div class="pair">
            <div>
              <span class="side">{{ t('library.update.before') }}</span>
              <LessonBlocks :blocks="[c.before]" :blocks-state="{}" readonly />
            </div>
            <div>
              <span class="side">{{ t('library.update.after') }}</span>
              <LessonBlocks :blocks="[c.after]" :blocks-state="{}" readonly />
            </div>
          </div>
        </details>

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
.sub-title { margin: 0; font-size: var(--font-size-body-s); font-weight: 900; text-transform: uppercase; letter-spacing: 0.04em; color: var(--color-ink-muted); }
.changelog { margin: 0; padding-left: var(--space-4); display: grid; gap: var(--space-2); }
.log { margin: var(--space-1) 0 0; }
.badge { margin-left: var(--space-2); }
.block { border-radius: var(--radius-s); padding: var(--space-2) var(--space-3); border: 1px solid var(--color-bg-line); background: var(--color-bg); display: grid; gap: var(--space-2); }
.block.added { border-color: var(--color-teal); background: var(--color-teal-soft); }
.block.removed { border-color: var(--color-coral); background: var(--color-coral-soft); }
.block.changed { border-color: var(--color-sun); background: var(--color-sun-soft); }
.tag { font-size: var(--font-size-body-s); font-weight: 800; cursor: default; }
details .tag { cursor: pointer; }
.pair { display: grid; grid-template-columns: repeat(auto-fit, minmax(220px, 1fr)); gap: var(--space-3); margin-top: var(--space-2); }
.side { display: block; font-size: var(--font-size-body-s); font-weight: 800; color: var(--color-ink-muted); margin-bottom: var(--space-1); }
.actions { display: flex; gap: var(--space-2); justify-content: flex-end; flex-wrap: wrap; }
</style>
