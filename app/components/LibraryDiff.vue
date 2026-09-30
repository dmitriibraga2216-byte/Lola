<script setup lang="ts">
import type { ContentBlock } from '#shared/schemas/content'

/**
 * Changelog пропущенных версий и поблочный diff двух версий модуля (docs/v2/31 §5.2 «Порівняти з v3»,
 * §5.5): добавленные блоки — бирюзой, удалённые — кораллом, изменённые — «було / стало». Данные
 * считает сервер (`GET …/versions/:from/diff/:to`, `GET /library/usages/:id/update-preview`).
 */
export interface LibraryDiffVersion { id: string, version: number, publishedAt: string, changelog: string, isHotfix: boolean }
export interface LibraryCompare {
  changelogs: LibraryDiffVersion[]
  diff: { added: string[], removed: string[], changed: string[] }
  before: ContentBlock[]
  after: ContentBlock[]
}

const props = defineProps<{ compare: LibraryCompare }>()
const { t } = useI18n()
const { formatShortDate } = useFormat()

const byId = (blocks: ContentBlock[]) => new Map(blocks.map(b => [b.id, b]))
const blocks = computed(() => {
  const c = props.compare
  const before = byId(c.before), after = byId(c.after)
  return {
    added: c.diff.added.map(id => after.get(id)).filter((b): b is ContentBlock => !!b),
    removed: c.diff.removed.map(id => before.get(id)).filter((b): b is ContentBlock => !!b),
    changed: c.diff.changed.map(id => ({ id, before: before.get(id), after: after.get(id) }))
      .filter((x): x is { id: string, before: ContentBlock, after: ContentBlock } => !!x.before && !!x.after),
  }
})
const noBlockChanges = computed(() => !blocks.value.added.length && !blocks.value.removed.length && !blocks.value.changed.length)
</script>

<template>
  <div class="library-diff">
    <h3 class="sub-title">{{ t('library.update.changes') }}</h3>
    <ol class="changelog">
      <li v-for="v in compare.changelogs" :key="v.id">
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
  </div>
</template>

<style scoped>
.library-diff { display: grid; gap: var(--space-3); }
.sub-title { margin: 0; font-size: var(--font-size-body-s); font-weight: 900; text-transform: uppercase; letter-spacing: 0.04em; color: var(--color-ink-muted); }
.changelog { margin: 0; padding-left: var(--space-4); display: grid; gap: var(--space-2); }
.log { margin: var(--space-1) 0 0; overflow-wrap: anywhere; }
.badge { margin-left: var(--space-2); }
.block { border-radius: var(--radius-s); padding: var(--space-2) var(--space-3); border: 1px solid var(--color-bg-line); background: var(--color-bg); display: grid; gap: var(--space-2); }
.block.added { border-color: var(--color-teal); background: var(--color-teal-soft); }
.block.removed { border-color: var(--color-coral); background: var(--color-coral-soft); }
.block.changed { border-color: var(--color-sun); background: var(--color-sun-soft); }
.tag { font-size: var(--font-size-body-s); font-weight: 800; cursor: default; }
details .tag { cursor: pointer; }
.pair { display: grid; grid-template-columns: repeat(auto-fit, minmax(220px, 1fr)); gap: var(--space-3); margin-top: var(--space-2); }
.side { display: block; font-size: var(--font-size-body-s); font-weight: 800; color: var(--color-ink-muted); margin-bottom: var(--space-1); }
</style>
