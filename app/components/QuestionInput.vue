<script setup lang="ts">
/** Ввод ответа по типу вопроса (docs/12 §5.4, коды docs/02). Эталонов здесь нет — только options. */
const props = defineProps<{
  kind: string
  options: unknown
  modelValue: unknown
  disabled?: boolean
  /** Потрібен лише для `cloze`: текст із плейсхолдерами `{{id}}` (докс/33 D-015). */
  stem?: unknown
}>()
const emit = defineEmits<{ (e: 'update:modelValue', v: unknown): void }>()
const { api } = useApi()

type Opt = { id: string, text: string }
type Area = { id: string, shape: 'rect', x: number, y: number, w: number, h: number } | { id: string, shape: 'circle', cx: number, cy: number, r: number }
const list = computed(() => (Array.isArray(props.options) ? props.options : []) as Opt[])
const matchOpts = computed(() => (props.options ?? { left: [], right: [] }) as { left: Opt[], right: Opt[] })
const classOpts = computed(() => (props.options ?? { groups: [], items: [] }) as { groups: { id: string, title: string }[], items: Opt[] })
const mapOpts = computed(() => (props.options ?? { imageMediaId: '', areas: [] }) as { imageMediaId: string, areas: Area[] })
const mapUrl = ref('')
watch(() => mapOpts.value.imageMediaId, async (id) => {
  mapUrl.value = ''
  if (props.kind !== 'answer_by_map' || !id) return
  try {
    const m = await api<{ urls: Record<string, string> }>(`/media/${id}`)
    mapUrl.value = m.urls['1280'] || m.urls['768'] || m.urls.original || ''
  }
  catch { mapUrl.value = '' }
}, { immediate: true })

function areaStyle(a: Area) {
  return a.shape === 'rect'
    ? { left: `${a.x * 100}%`, top: `${a.y * 100}%`, width: `${a.w * 100}%`, height: `${a.h * 100}%` }
    : { left: `${(a.cx - a.r) * 100}%`, top: `${(a.cy - a.r) * 100}%`, width: `${a.r * 200}%`, height: `${a.r * 200}%`, borderRadius: '50%' }
}
function toggleArea(id: string) {
  const cur = new Set((val.value.areaIds as string[] | undefined) ?? [])
  if (cur.has(id)) cur.delete(id)
  else cur.add(id)
  val.value = { areaIds: [...cur] }
}
function place(itemId: string, groupId: string) {
  const placements = ((val.value.placements as { itemId: string, groupId: string }[] | undefined) ?? []).filter(p => p.itemId !== itemId)
  if (groupId) placements.push({ itemId, groupId })
  val.value = { placements }
}
function placedIn(itemId: string) {
  return ((val.value.placements as { itemId: string, groupId: string }[] | undefined) ?? []).find(p => p.itemId === itemId)?.groupId ?? ''
}

const val = computed({
  get: () => (props.modelValue ?? {}) as Record<string, unknown>,
  set: v => emit('update:modelValue', v),
})

// cloze (докс/33 D-015): stem — блоки text/…; беремо текст без тегів і ріжемо по {{id}}
type ClozePart = { type: 'text', value: string } | { type: 'gap', id: string }
const clozeParts = computed<ClozePart[]>(() => {
  const blocks = (Array.isArray(props.stem) ? props.stem : []) as { type: string, html?: string }[]
  const text = blocks.filter(b => b.type === 'text').map(b => (b.html ?? '').replace(/<[^>]+>/g, '')).join(' ')
  const parts: ClozePart[] = []
  let last = 0
  for (const m of text.matchAll(/\{\{(\w+)\}\}/g)) {
    if (m.index! > last) parts.push({ type: 'text', value: text.slice(last, m.index) })
    parts.push({ type: 'gap', id: m[1]! })
    last = m.index! + m[0].length
  }
  if (last < text.length) parts.push({ type: 'text', value: text.slice(last) })
  return parts
})
function clozeValue(id: string): string {
  return String(((val.value.values as Record<string, string> | undefined) ?? {})[id] ?? '')
}
function setCloze(id: string, text: string) {
  val.value = { values: { ...((val.value.values as Record<string, string> | undefined) ?? {}), [id]: text } }
}

function pickSingle(id: string) {
  val.value = { optionId: id }
}
function toggleMulti(id: string) {
  const cur = new Set((val.value.optionIds as string[] | undefined) ?? [])
  if (cur.has(id)) cur.delete(id)
  else cur.add(id)
  val.value = { optionIds: [...cur] }
}
const order = computed(() => ((val.value.order as string[] | undefined) ?? list.value.map(o => o.id)))
function moveOrder(index: number, dir: -1 | 1) {
  const next = [...order.value]
  const t = index + dir
  if (t < 0 || t >= next.length) return
  ;[next[index], next[t]] = [next[t]!, next[index]!]
  val.value = { order: next }
}
function setPair(leftId: string, rightId: string) {
  const pairs = ((val.value.pairs as { leftId: string, rightId: string }[] | undefined) ?? []).filter(p => p.leftId !== leftId)
  if (rightId) pairs.push({ leftId, rightId })
  val.value = { pairs }
}
function pairFor(leftId: string) {
  return ((val.value.pairs as { leftId: string, rightId: string }[] | undefined) ?? []).find(p => p.leftId === leftId)?.rightId ?? ''
}
</script>

<template>
  <div class="q-input">
    <template v-if="kind === 'single'">
      <button
        v-for="o in list"
        :key="o.id"
        :class="['opt', { on: val.optionId === o.id }]"
        :disabled="disabled"
        @click="pickSingle(o.id)"
      >
        {{ o.text }}
      </button>
    </template>

    <template v-else-if="kind === 'multi'">
      <button
        v-for="o in list"
        :key="o.id"
        :class="['opt', { on: ((val.optionIds as string[]) ?? []).includes(o.id) }]"
        :disabled="disabled"
        @click="toggleMulti(o.id)"
      >
        {{ o.text }}
      </button>
    </template>

    <template v-else-if="kind === 'ordering'">
      <div v-for="(id, i) in order" :key="id" class="opt row">
        <span class="n">{{ i + 1 }}</span>
        <span class="grow">{{ list.find(o => o.id === id)?.text }}</span>
        <button class="mini" :disabled="disabled || i === 0" @click="moveOrder(i, -1)">↑</button>
        <button class="mini" :disabled="disabled || i === order.length - 1" @click="moveOrder(i, 1)">↓</button>
      </div>
    </template>

    <template v-else-if="kind === 'comparison'">
      <div v-for="l in matchOpts.left" :key="l.id" class="opt row">
        <span class="grow">{{ l.text }}</span>
        <select :value="pairFor(l.id)" :disabled="disabled" @change="setPair(l.id, ($event.target as HTMLSelectElement).value)">
          <option value="">—</option>
          <option v-for="r in matchOpts.right" :key="r.id" :value="r.id">{{ r.text }}</option>
        </select>
      </div>
    </template>

    <!-- Класифікація: кожному варіанту — клас -->
    <template v-else-if="kind === 'classification'">
      <div v-for="it in classOpts.items" :key="it.id" class="opt row">
        <span class="grow">{{ it.text }}</span>
        <select :value="placedIn(it.id)" :disabled="disabled" @change="place(it.id, ($event.target as HTMLSelectElement).value)">
          <option value="">—</option>
          <option v-for="g in classOpts.groups" :key="g.id" :value="g.id">{{ g.title }}</option>
        </select>
      </div>
    </template>

    <!-- Вибір на зображенні: області в долях, кнопки поверх картинки (доступно з клавіатури) -->
    <div v-else-if="kind === 'answer_by_map'" class="map">
      <img v-if="mapUrl" :src="mapUrl" alt="">
      <button
        v-for="(a, i) in mapOpts.areas"
        :key="a.id"
        type="button"
        :class="['area', { on: ((val.areaIds as string[]) ?? []).includes(a.id) }]"
        :style="areaStyle(a)"
        :aria-pressed="((val.areaIds as string[]) ?? []).includes(a.id)"
        :aria-label="String(i + 1)"
        :disabled="disabled"
        @click="toggleArea(a.id)"
      >
        {{ i + 1 }}
      </button>
    </div>

    <input
      v-else-if="kind === 'number'"
      class="field"
      type="text"
      inputmode="decimal"
      :value="String(val.value ?? '')"
      :disabled="disabled"
      placeholder="0"
      @input="val = { value: ($event.target as HTMLInputElement).value }"
    >

    <input
      v-else-if="kind === 'text_short'"
      class="field"
      type="text"
      :value="String(val.text ?? '')"
      :disabled="disabled"
      @input="val = { text: ($event.target as HTMLInputElement).value }"
    >

    <textarea
      v-else-if="kind === 'free'"
      class="field"
      rows="6"
      :value="String(val.text ?? '')"
      :disabled="disabled"
      @input="val = { text: ($event.target as HTMLTextAreaElement).value }"
    />

    <p v-else-if="kind === 'cloze'" class="cloze">
      <template v-for="(part, i) in clozeParts" :key="i">
        <span v-if="part.type === 'text'">{{ part.value }}</span>
        <input
          v-else
          class="field cloze-gap"
          type="text"
          :aria-label="part.id"
          :value="clozeValue(part.id)"
          :disabled="disabled"
          @input="setCloze(part.id, ($event.target as HTMLInputElement).value)"
        >
      </template>
    </p>

    <p v-else class="muted">{{ kind }}</p>
  </div>
</template>

<style scoped>
.q-input {
  display: grid;
  gap: var(--space-2);
}

.opt {
  font: inherit;
  text-align: left;
  background: var(--color-bg-soft);
  border: 2px solid var(--color-bg-line);
  border-radius: var(--radius-m);
  padding: var(--space-3) var(--space-4);
  color: var(--color-ink);
  cursor: pointer;
}

.opt.on {
  /* Мокап Test: вибраний варіант — солонцевий (сонячний) відтінок, не тон фону сторінки */
  background: var(--color-sun-soft);
  border-color: var(--color-ink);
  font-weight: 700;
}

.opt:disabled {
  cursor: default;
}

.row {
  display: flex;
  align-items: center;
  gap: var(--space-2);
  cursor: default;
}

.grow {
  flex: 1;
}

.n {
  width: 24px;
  height: 24px;
  border-radius: var(--radius-pill);
  background: var(--color-ink);
  color: var(--color-bg-soft);
  display: grid;
  place-items: center;
  font-size: var(--font-size-body-s);
  font-weight: 800;
}

.mini {
  font: inherit;
  border: 1px solid var(--color-bg-line);
  background: var(--color-bg);
  border-radius: var(--radius-pill);
  width: 32px;
  height: 32px;
  cursor: pointer;
}

.mini:disabled {
  opacity: 0.3;
}

.field,
select {
  font: inherit;
  border: 2px solid var(--color-bg-line);
  border-radius: var(--radius-m);
  padding: var(--space-3) var(--space-4);
  background: var(--color-bg-soft);
  color: var(--color-ink);
  width: 100%;
  box-sizing: border-box;
}

select {
  width: auto;
  padding: var(--space-1) var(--space-2);
}

.muted {
  color: var(--color-ink-faint);
}

.map {
  position: relative;
  aspect-ratio: 16 / 9;
  background: var(--color-bg-soft);
  border-radius: var(--radius-m);
  overflow: hidden;
}

.map img {
  width: 100%;
  height: 100%;
  object-fit: contain;
  display: block;
}

.area {
  position: absolute;
  font: inherit;
  font-weight: 800;
  border: 2px solid var(--color-ink);
  background: color-mix(in srgb, var(--color-bg-soft) 40%, transparent);
  color: var(--color-ink);
  cursor: pointer;
  border-radius: var(--radius-s);
}

.area.on {
  border-color: var(--color-teal);
  background: color-mix(in srgb, var(--color-teal) 35%, transparent);
}

.area:focus-visible {
  outline: 3px solid var(--color-sun);
}

.cloze {
  line-height: 2.4;
  margin: 0;
}

.cloze-gap {
  display: inline-block;
  width: auto;
  min-width: 96px;
  padding: var(--space-1) var(--space-2);
  margin: 0 var(--space-1);
}
</style>
