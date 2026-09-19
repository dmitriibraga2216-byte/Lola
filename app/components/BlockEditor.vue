<script setup lang="ts">
import type { ContentBlock } from '../../shared/schemas/content'

const props = defineProps<{ modelValue: ContentBlock[] }>()
const emit = defineEmits<{ (e: 'update:modelValue', v: ContentBlock[]): void }>()

const { t } = useI18n()
const { api } = useApi()


const uploadingFor = ref('')
const uploadError = ref('')

function newId() {
  return `b_${Math.random().toString(36).slice(2, 10)}`
}

function update(index: number, patch: Partial<ContentBlock>) {
  const next = [...props.modelValue]
  next[index] = { ...next[index], ...patch } as ContentBlock
  emit('update:modelValue', next)
}

function remove(index: number) {
  emit('update:modelValue', props.modelValue.filter((_, i) => i !== index))
}

function move(index: number, dir: -1 | 1) {
  const target = index + dir
  if (target < 0 || target >= props.modelValue.length) return
  const next = [...props.modelValue]
  const [item] = next.splice(index, 1)
  next.splice(target, 0, item!)
  emit('update:modelValue', next)
}

function add(type: ContentBlock['type']) {
  const id = newId()
  const block: ContentBlock = (() => {
    switch (type) {
      case 'heading': return { id, type, level: 2, text: '' }
      case 'text': return { id, type, html: '<p></p>' }
      case 'image': return { id, type, mediaId: '', alt: '', width: 'full' }
      case 'video': return { id, type, mediaId: '', allowSeek: true }
      case 'file': return { id, type, mediaId: '', name: '' }
      case 'callout': return { id, type, tone: 'info', text: '' }
      case 'checklist': return { id, type, items: [''], requireAll: true }
      case 'quote': return { id, type, text: '' }
      case 'embed': return { id, type, provider: 'youtube', videoId: '' }
      default: return { id, type: 'divider' }
    }
  })()
  emit('update:modelValue', [...props.modelValue, block])
}

/** Presigned PUT напрямую в хранилище, затем complete → обработка (docs/11 §7.6). */
async function upload(index: number, e: Event) {
  const file = (e.target as HTMLInputElement).files?.[0]
  if (!file) return
  uploadingFor.value = props.modelValue[index]!.id
  uploadError.value = ''
  try {
    const { mediaId, uploadUrl } = await api<{ mediaId: string, uploadUrl: string }>('/media/upload-url', {
      method: 'POST',
      body: { filename: file.name, mime: file.type, bytes: file.size },
    })
    const put = await fetch(uploadUrl, { method: 'PUT', body: file, headers: { 'Content-Type': file.type } })
    if (!put.ok) throw new Error('upload failed')
    await api(`/media/${mediaId}/complete`, { method: 'POST' })
    const block = props.modelValue[index]!
    update(index, { mediaId, ...(block.type === 'file' ? { name: file.name } : {}) } as Partial<ContentBlock>)
  }
  catch (err) {
    uploadError.value = apiErrorOf(err).message
  }
  finally {
    uploadingFor.value = ''
  }
}

const blockTypes: ContentBlock['type'][] = ['heading', 'text', 'image', 'video', 'file', 'callout', 'checklist', 'quote', 'embed', 'divider']
</script>

<template>
  <div class="editor">
    <div v-for="(block, index) in modelValue" :key="block.id" class="block">
      <div class="block-head">
        <span class="type">{{ t(`blocks.${block.type}`) }}</span>
        <div class="tools">
          <button :disabled="index === 0" @click="move(index, -1)">↑</button>
          <button :disabled="index === modelValue.length - 1" @click="move(index, 1)">↓</button>
          <button class="danger" @click="remove(index)">✕</button>
        </div>
      </div>

      <template v-if="block.type === 'heading'">
        <select :value="block.level" @change="update(index, { level: Number(($event.target as HTMLSelectElement).value) as 2 | 3 })">
          <option :value="2">H2</option>
          <option :value="3">H3</option>
        </select>
        <input :value="block.text" :placeholder="t('blocks.headingText')" @input="update(index, { text: ($event.target as HTMLInputElement).value })">
      </template>

      <textarea
        v-else-if="block.type === 'text'"
        :value="block.html"
        rows="6"
        :placeholder="t('blocks.textHint')"
        @input="update(index, { html: ($event.target as HTMLTextAreaElement).value })"
      />

      <template v-else-if="block.type === 'image' || block.type === 'video' || block.type === 'file'">
        <div class="upload-row">
          <input type="file" :accept="block.type === 'image' ? 'image/*' : block.type === 'video' ? 'video/*' : '*'" @change="upload(index, $event)">
          <span v-if="uploadingFor === block.id" class="sub">{{ t('blocks.uploading') }}</span>
          <span v-else-if="block.mediaId" class="sub ok">{{ t('blocks.uploaded') }}</span>
        </div>
        <input
          v-if="block.type === 'image'"
          :value="block.alt"
          :placeholder="t('blocks.alt')"
          @input="update(index, { alt: ($event.target as HTMLInputElement).value })"
        >
        <input
          v-if="block.type === 'image'"
          :value="block.caption"
          :placeholder="t('blocks.caption')"
          @input="update(index, { caption: ($event.target as HTMLInputElement).value })"
        >
      </template>

      <template v-else-if="block.type === 'callout'">
        <select :value="block.tone" @change="update(index, { tone: ($event.target as HTMLSelectElement).value as 'info' })">
          <option value="info">info</option>
          <option value="warn">warn</option>
          <option value="danger">danger</option>
          <option value="success">success</option>
        </select>
        <input :value="block.title" :placeholder="t('blocks.calloutTitle')" @input="update(index, { title: ($event.target as HTMLInputElement).value })">
        <textarea :value="block.text" rows="3" @input="update(index, { text: ($event.target as HTMLTextAreaElement).value })" />
      </template>

      <template v-else-if="block.type === 'checklist'">
        <textarea
          :value="block.items.join('\n')"
          rows="4"
          :placeholder="t('blocks.checklistHint')"
          @input="update(index, { items: ($event.target as HTMLTextAreaElement).value.split('\n').filter(Boolean) })"
        />
        <label class="check">
          <input type="checkbox" :checked="block.requireAll" @change="update(index, { requireAll: ($event.target as HTMLInputElement).checked })">
          {{ t('blocks.requireAll') }}
        </label>
      </template>

      <template v-else-if="block.type === 'quote'">
        <textarea :value="block.text" rows="3" @input="update(index, { text: ($event.target as HTMLTextAreaElement).value })" />
        <input :value="block.author" :placeholder="t('blocks.author')" @input="update(index, { author: ($event.target as HTMLInputElement).value })">
      </template>

      <template v-else-if="block.type === 'embed'">
        <select :value="block.provider" @change="update(index, { provider: ($event.target as HTMLSelectElement).value as 'youtube' })">
          <option value="youtube">YouTube</option>
          <option value="vimeo">Vimeo</option>
        </select>
        <input :value="block.videoId" :placeholder="t('blocks.videoId')" @input="update(index, { videoId: ($event.target as HTMLInputElement).value })">
      </template>
    </div>

    <p v-if="uploadError" class="error">{{ uploadError }}</p>

    <div class="add">
      <span class="sub">+</span>
      <button v-for="type in blockTypes" :key="type" class="chip" @click="add(type)">
        {{ t(`blocks.${type}`) }}
      </button>
    </div>
  </div>
</template>

<style scoped>
.editor {
  display: grid;
  gap: var(--space-3);
}

.block {
  background: var(--color-bg-soft);
  border-radius: var(--radius-m);
  padding: var(--space-3);
  display: grid;
  gap: var(--space-2);
}

.block-head {
  display: flex;
  align-items: center;
  justify-content: space-between;
}

.type {
  font-size: var(--font-size-body-s);
  font-weight: 700;
  color: var(--color-ink-muted);
}

.tools {
  display: flex;
  gap: var(--space-1);
}

.tools button {
  font: inherit;
  border: 1px solid var(--color-bg-line);
  background: var(--color-bg);
  border-radius: var(--radius-pill);
  width: 28px;
  height: 28px;
  cursor: pointer;
  color: var(--color-ink);
}

.tools button:disabled {
  opacity: 0.3;
}

.tools .danger {
  color: var(--color-coral-ink);
}

input,
textarea,
select {
  font: inherit;
  border: 1px solid var(--color-bg-line);
  border-radius: var(--radius-s);
  padding: var(--space-2) var(--space-3);
  background: var(--color-bg);
  color: var(--color-ink);
  width: 100%;
  box-sizing: border-box;
}

textarea {
  resize: vertical;
}

.upload-row {
  display: flex;
  gap: var(--space-3);
  align-items: center;
  flex-wrap: wrap;
}

.upload-row input[type="file"] {
  width: auto;
  border: none;
  padding: 0;
  background: none;
}

.sub {
  font-size: var(--font-size-body-s);
  color: var(--color-ink-faint);
}

.sub.ok {
  color: var(--color-teal-ink);
}

.check {
  display: flex;
  gap: var(--space-2);
  align-items: center;
  font-size: var(--font-size-body-s);
}

.check input {
  width: auto;
}

.add {
  display: flex;
  gap: var(--space-2);
  flex-wrap: wrap;
  align-items: center;
}

.chip {
  font: inherit;
  font-size: var(--font-size-body-s);
  font-weight: 700;
  border: 1px solid var(--color-bg-line);
  background: transparent;
  color: var(--color-ink-muted);
  border-radius: var(--radius-pill);
  padding: var(--space-1) var(--space-3);
  cursor: pointer;
}

.error {
  color: var(--color-coral-ink);
  margin: 0;
}
</style>
