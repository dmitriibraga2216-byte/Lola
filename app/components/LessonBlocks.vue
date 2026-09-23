<script setup lang="ts">
import type { ContentBlock } from '../../shared/schemas/content'

const props = defineProps<{
  blocks: ContentBlock[]
  blocksState: Record<string, unknown>
  readonly?: boolean
  /**
   * Точечный флажок «Повідомити про помилку» у каждого блока (docs/v2/36 §5.1): передаётся
   * только плеером урока. Без него компонент выглядит ровно как раньше — предпросмотры,
   * описание теста и админские экраны флажков не получают.
   */
  report?: {
    targetType: 'resource' | 'lesson'
    targetId: string
    source: 'lesson' | 'catalog' | 'knowledge'
    enrollmentId?: string | null
    lessonId?: string | null
    whereLabel?: string
  }
}>()

const emit = defineEmits<{
  (e: 'checklist', blockId: string, checked: number[]): void
  (e: 'video', pct: number): void
}>()

const { api } = useApi()

const mediaUrls = ref<Record<string, { urls: Record<string, string>, status: string }>>({})

onMounted(async () => {
  const ids = props.blocks.flatMap(b => ('mediaId' in b ? [b.mediaId] : []))
  await Promise.all([...new Set(ids)].map(async (id) => {
    try {
      mediaUrls.value[id] = await api(`/media/${id}`)
    }
    catch { /* блок покажет ошибку загрузки */ }
  }))
})

function checked(blockId: string): number[] {
  return (props.blocksState[blockId] as number[] | undefined) ?? []
}

function toggle(blockId: string, index: number) {
  if (props.readonly) return
  const current = new Set(checked(blockId))
  if (current.has(index)) current.delete(index)
  else current.add(index)
  emit('checklist', blockId, [...current].sort((a, b) => a - b))
}

let maxPct = 0
let lastVideoSec = 0
function onTimeUpdate(e: Event) {
  const video = e.target as HTMLVideoElement
  lastVideoSec = video.currentTime
  if (!video.duration) return
  const pct = Math.floor(video.currentTime / video.duration * 100)
  if (pct > maxPct) {
    maxPct = pct
    emit('video', pct)
  }
}

/** Позиция плеера и прокрутка на момент жалобы (§7.1) — их знает только этот компонент. */
function collectContext() {
  return {
    playerPositionSec: Math.round(lastVideoSec),
    scrollPct: typeof window === 'undefined'
      ? undefined
      : Math.min(100, Math.round((window.scrollY + window.innerHeight) / Math.max(1, document.body.scrollHeight) * 100)),
  }
}

function imageSrc(mediaId: string): string | undefined {
  const m = mediaUrls.value[mediaId]
  return m?.urls['768'] || m?.urls.original
}
</script>

<template>
  <div class="blocks">
    <template v-for="block in blocks" :key="block.id">
      <component :is="`h${block.level}`" v-if="block.type === 'heading'" class="heading">
        {{ block.text }}
      </component>

      <!-- eslint-disable-next-line vue/no-v-html -- HTML санитизирован на сервере при сохранении -->
      <div v-else-if="block.type === 'text'" class="text" v-html="block.html" />

      <figure v-else-if="block.type === 'image'" :class="['image', block.width]">
        <img v-if="imageSrc(block.mediaId)" :src="imageSrc(block.mediaId)" :alt="block.alt" loading="lazy">
        <div v-else class="media-placeholder">{{ block.alt }}</div>
        <figcaption v-if="block.caption">{{ block.caption }}</figcaption>
      </figure>

      <div v-else-if="block.type === 'video'" class="video">
        <video
          v-if="mediaUrls[block.mediaId]?.urls.original"
          :src="mediaUrls[block.mediaId]!.urls['720'] || mediaUrls[block.mediaId]!.urls.original"
          :poster="mediaUrls[block.mediaId]!.urls.poster"
          controls
          playsinline
          preload="metadata"
          @timeupdate="onTimeUpdate"
        />
        <div v-else class="media-placeholder">…</div>
      </div>

      <a
        v-else-if="block.type === 'file'"
        class="file"
        :href="mediaUrls[block.mediaId]?.urls.original"
        target="_blank"
        rel="noopener"
      >
        📎 {{ block.name }}
      </a>

      <div v-else-if="block.type === 'callout'" :class="['callout', block.tone]">
        <b v-if="block.title">{{ block.title }}</b>
        <p>{{ block.text }}</p>
      </div>

      <ul v-else-if="block.type === 'checklist'" class="checklist">
        <li v-for="(item, index) in block.items" :key="index">
          <label>
            <input
              type="checkbox"
              :checked="checked(block.id).includes(index)"
              :disabled="readonly"
              @change="toggle(block.id, index)"
            >
            <span>{{ item }}</span>
          </label>
        </li>
      </ul>

      <blockquote v-else-if="block.type === 'quote'" class="quote">
        <p>{{ block.text }}</p>
        <cite v-if="block.author">— {{ block.author }}</cite>
      </blockquote>

      <div v-else-if="block.type === 'embed'" class="embed">
        <iframe
          :src="block.provider === 'youtube'
            ? `https://www.youtube-nocookie.com/embed/${block.videoId}${block.startSec ? `?start=${block.startSec}` : ''}`
            : `https://player.vimeo.com/video/${block.videoId}`"
          allow="accelerometer; encrypted-media; picture-in-picture"
          allowfullscreen
          loading="lazy"
        />
      </div>

      <hr v-else-if="block.type === 'divider'" class="divider">

      <!-- Флажок у блока: подставляет block_id, чтобы автор понял, какой именно абзац (§5.1) -->
      <div v-if="report && block.type !== 'divider'" class="block-flag">
        <ContentIssueReport
          compact
          :target-type="report.targetType"
          :target-id="report.targetId"
          :block-id="block.id"
          :source="report.source"
          :enrollment-id="report.enrollmentId"
          :lesson-id="report.lessonId"
          :where-label="report.whereLabel"
          :collect="collectContext"
        />
      </div>
    </template>
  </div>
</template>

<style scoped>
.blocks {
  display: grid;
  gap: var(--space-4);
  max-width: 68ch;
}

.heading {
  margin: var(--space-2) 0 0;
  font-weight: 900;
}

.text :deep(p) {
  margin: 0 0 var(--space-3);
  line-height: 1.55;
}

.text :deep(a) {
  color: var(--color-teal-ink);
}

.text :deep(table) {
  border-collapse: collapse;
  width: 100%;
}

.text :deep(td),
.text :deep(th) {
  border: 1px solid var(--color-bg-line);
  padding: var(--space-1) var(--space-2);
}

.block-flag {
  display: flex;
  justify-content: flex-end;
  margin: calc(-1 * var(--space-2)) 0 var(--space-3);
}

.image {
  margin: 0;
}

.image img {
  width: 100%;
  border-radius: var(--radius-m);
  display: block;
}

.image.half img {
  max-width: 50%;
}

figcaption {
  font-size: var(--font-size-body-s);
  color: var(--color-ink-faint);
  margin-top: var(--space-1);
}

.video video {
  width: 100%;
  border-radius: var(--radius-m);
  background: var(--color-ink);
}

.media-placeholder {
  background: var(--color-bg-line-soft);
  border-radius: var(--radius-m);
  padding: var(--space-6);
  text-align: center;
  color: var(--color-ink-faint);
}

.file {
  display: inline-block;
  background: var(--color-bg-soft);
  border: 1px solid var(--color-bg-line);
  border-radius: var(--radius-s);
  padding: var(--space-2) var(--space-4);
  color: var(--color-ink);
  text-decoration: none;
  font-weight: 700;
}

.callout {
  border-radius: var(--radius-m);
  padding: var(--space-3) var(--space-4);
  border-left: 4px solid;
}

.callout p {
  margin: var(--space-1) 0 0;
}

.callout.info { background: var(--color-bg-soft); border-color: var(--color-ink-faint); }
.callout.warn { background: color-mix(in srgb, var(--color-sun) 25%, transparent); border-color: var(--color-sun); }
.callout.danger { background: color-mix(in srgb, var(--color-coral) 18%, transparent); border-color: var(--color-coral); }
.callout.success { background: color-mix(in srgb, var(--color-teal) 18%, transparent); border-color: var(--color-teal); }

.checklist {
  list-style: none;
  margin: 0;
  padding: 0;
  display: grid;
  gap: var(--space-2);
}

.checklist label {
  display: flex;
  gap: var(--space-3);
  align-items: flex-start;
  background: var(--color-bg-soft);
  border-radius: var(--radius-s);
  padding: var(--space-3);
  cursor: pointer;
}

.checklist input {
  width: 20px;
  height: 20px;
  accent-color: var(--color-teal);
  flex: none;
}

.quote {
  margin: 0;
  padding-left: var(--space-4);
  border-left: 3px solid var(--color-bg-line);
  color: var(--color-ink-muted);
  font-style: italic;
}

.quote p {
  margin: 0;
}

.embed {
  aspect-ratio: 16 / 9;
  border-radius: var(--radius-m);
  overflow: hidden;
}

.embed iframe {
  width: 100%;
  height: 100%;
  border: none;
}

.divider {
  border: none;
  border-top: 1px solid var(--color-bg-line);
  margin: var(--space-2) 0;
}
</style>
