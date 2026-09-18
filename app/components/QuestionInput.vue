<script setup lang="ts">
/** Ввод ответа по типу вопроса (docs/12 §5.4). Эталонов здесь нет — только options. */
const props = defineProps<{
  kind: string
  options: unknown
  modelValue: unknown
  disabled?: boolean
}>()
const emit = defineEmits<{ (e: 'update:modelValue', v: unknown): void }>()

type Opt = { id: string, text: string }
const list = computed(() => (Array.isArray(props.options) ? props.options : []) as Opt[])
const matchOpts = computed(() => (props.options ?? { left: [], right: [] }) as { left: Opt[], right: Opt[] })

const val = computed({
  get: () => (props.modelValue ?? {}) as Record<string, unknown>,
  set: v => emit('update:modelValue', v),
})

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

    <template v-else-if="kind === 'multiple'">
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

    <template v-else-if="kind === 'order'">
      <div v-for="(id, i) in order" :key="id" class="opt row">
        <span class="n">{{ i + 1 }}</span>
        <span class="grow">{{ list.find(o => o.id === id)?.text }}</span>
        <button class="mini" :disabled="disabled || i === 0" @click="moveOrder(i, -1)">↑</button>
        <button class="mini" :disabled="disabled || i === order.length - 1" @click="moveOrder(i, 1)">↓</button>
      </div>
    </template>

    <template v-else-if="kind === 'match'">
      <div v-for="l in matchOpts.left" :key="l.id" class="opt row">
        <span class="grow">{{ l.text }}</span>
        <select :value="pairFor(l.id)" :disabled="disabled" @change="setPair(l.id, ($event.target as HTMLSelectElement).value)">
          <option value="">—</option>
          <option v-for="r in matchOpts.right" :key="r.id" :value="r.id">{{ r.text }}</option>
        </select>
      </div>
    </template>

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
      v-else-if="kind === 'text_long'"
      class="field"
      rows="6"
      :value="String(val.text ?? '')"
      :disabled="disabled"
      @input="val = { text: ($event.target as HTMLTextAreaElement).value }"
    />

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
  background: var(--color-bg);
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
</style>
