<script setup lang="ts">
/**
 * Карточка узла дерева подчинения (docs/v2/32 §5.1, §5.2).
 *
 * Узел-посада показывает подпись и счётчик «N з M», именной — ФИО, аватар-инициалы и e-mail.
 * Вакантный узел — серым пунктиром с подписью «Вакансія». Иконки управления (человек, плюс,
 * карандаш, корзина) рисуются **только** в режиме конструктора и **только** для узлов своей
 * ветки: у сотрудника и у чужой ветки их нет вовсе (критерий приёмки 8).
 *
 * Всё интерактивное — кнопки, значит доступно с клавиатуры; свёртка ветки объявлена
 * `aria-expanded`, перетаскивание дублируется полем «Батьківський вузол» формы узла
 * (клавиатурный путь, PR-31).
 */
interface Holder { assignmentId?: string, userId: string, fullName: string, email: string | null, roleInNode: string, isPrimary: boolean }
interface Node {
  id: string
  parentId: string | null
  depth: number
  type: 'position' | 'employee'
  title: string
  note?: string | null
  positionId: string | null
  positionName: string | null
  locationId: string | null
  locationName: string | null
  orgUnitId: string | null
  orgUnitName: string | null
  headcountPlanned: number
  headcountActual: number
  isManagerPoint: boolean
  state: 'vacant' | 'occupied' | 'archived'
  holders: Holder[]
  children: Node[]
}

const props = defineProps<{
  node: Node
  mode: 'admin' | 'view'
  editableIds: Set<string>
  canEditAll: boolean
  collapsed: Record<string, boolean>
  dropTarget: string
  myId: string
}>()
const emit = defineEmits<{
  toggle: [id: string]
  assign: [node: Node]
  add: [parentId: string]
  edit: [node: Node]
  archive: [id: string]
  dragStart: [id: string]
  dragOver: [id: string]
  dropOn: [id: string]
}>()

const { t } = useI18n()
const editable = computed(() => props.mode === 'admin' && (props.canEditAll || props.editableIds.has(props.node.id)))
const open = computed(() => !props.collapsed[props.node.id])
const isMine = computed(() => props.node.holders.some(h => h.userId === props.myId))
const initials = (name: string) => name.split(/\s+/).filter(Boolean).slice(0, 2).map(w => w[0]!.toUpperCase()).join('')
</script>

<template>
  <li class="item">
    <div
      :class="['node', { vacant: node.state === 'vacant', mine: isMine, over: dropTarget === node.id, drop: editable }]"
      :draggable="editable"
      @dragstart="emit('dragStart', node.id)"
      @dragover.prevent="emit('dragOver', node.id)"
      @drop.prevent="emit('dropOn', node.id)"
    >
      <button v-if="node.children.length" class="tgl" :aria-expanded="open" :aria-label="node.title" @click="emit('toggle', node.id)">{{ open ? '▾' : '▸' }}</button>
      <span v-else class="tgl spacer" aria-hidden="true" />

      <span v-if="node.type === 'employee' && node.holders[0]" class="ava" aria-hidden="true">{{ initials(node.holders[0].fullName) }}</span>

      <span class="body">
        <b class="title">{{ node.type === 'employee' && node.holders[0] ? node.holders[0].fullName : node.title }}</b>
        <span v-if="node.type === 'employee' && node.holders[0]?.email" class="sub">{{ node.holders[0].email }}</span>
        <span v-if="node.locationName" class="badge">{{ node.locationName }}</span>
        <span v-if="node.isManagerPoint" class="badge lead">{{ t('orgStructure.managerPoint') }}</span>
        <span v-if="node.type === 'position'" :class="['sub', { over: node.headcountActual > node.headcountPlanned }]">{{ t('orgStructure.counter', { n: node.headcountActual, m: node.headcountPlanned }) }}</span>
        <span v-if="node.state === 'vacant'" class="sub">{{ t('orgStructure.vacancy') }}</span>
        <span v-if="isMine" class="badge me">{{ t('orgStructure.myNode') }}</span>
      </span>

      <!-- Четыре иконки эталона — только у своей ветки в режиме конструктора -->
      <span v-if="editable" class="icons">
        <button class="ico" :title="t('orgStructure.assign')" :aria-label="t('orgStructure.assign')" @click="emit('assign', node)">👤</button>
        <button class="ico" :title="t('orgStructure.addChild')" :aria-label="t('orgStructure.addChild')" @click="emit('add', node.id)">＋</button>
        <button class="ico" :title="t('orgStructure.edit')" :aria-label="t('orgStructure.edit')" @click="emit('edit', node)">✎</button>
        <button class="ico danger" :title="t('orgStructure.archive')" :aria-label="t('orgStructure.archive')" @click="emit('archive', node.id)">🗑</button>
      </span>
    </div>

    <ul v-if="open && node.children.length" class="kids">
      <OrgStructureNode
        v-for="c in node.children"
        :key="c.id"
        :node="c"
        :mode="mode"
        :editable-ids="editableIds"
        :can-edit-all="canEditAll"
        :collapsed="collapsed"
        :drop-target="dropTarget"
        :my-id="myId"
        @toggle="emit('toggle', $event)"
        @assign="emit('assign', $event)"
        @add="emit('add', $event)"
        @edit="emit('edit', $event)"
        @archive="emit('archive', $event)"
        @drag-start="emit('dragStart', $event)"
        @drag-over="emit('dragOver', $event)"
        @drop-on="emit('dropOn', $event)"
      />
    </ul>
  </li>
</template>

<style scoped>
.item { list-style: none; }
.node { display: flex; align-items: center; gap: var(--space-2); background: var(--color-bg-soft); border: 1px solid var(--color-bg-line); border-radius: var(--radius-m); padding: var(--space-2) var(--space-3); margin-bottom: var(--space-2); flex-wrap: wrap; min-width: 0; }
.node.vacant { border-style: dashed; color: var(--color-ink-muted); }
.node.mine { border-color: var(--color-teal); background: var(--color-teal-soft); }
.node.over { border-color: var(--color-sun); }
.tgl { font: inherit; background: none; border: none; cursor: pointer; color: var(--color-ink-muted); padding: 0; min-width: var(--space-4); }
.tgl.spacer { cursor: default; }
.ava { display: inline-flex; align-items: center; justify-content: center; width: var(--space-6); height: var(--space-6); border-radius: var(--radius-pill); background: var(--color-sun-soft); color: var(--color-ink); font-weight: 800; font-size: var(--font-size-body-s); }
.body { display: flex; align-items: center; gap: var(--space-2); flex-wrap: wrap; min-width: 0; }
.title { min-width: 0; overflow-wrap: anywhere; }
.badge { font-size: var(--font-size-body-s); border-radius: var(--radius-pill); padding: 0 var(--space-2); background: var(--color-bg); color: var(--color-ink-muted); }
.badge.lead { background: var(--color-sun-soft); color: var(--color-ink); }
.badge.me { background: var(--color-teal); color: var(--color-teal-ink); }
.icons { display: flex; gap: var(--space-1); margin-left: auto; }
.ico { font: inherit; border: 1px solid var(--color-bg-line); background: var(--color-bg); color: var(--color-ink); border-radius: var(--radius-pill); padding: 0 var(--space-2); cursor: pointer; }
.ico.danger { color: var(--color-coral-ink); }
.kids { list-style: none; margin: 0 0 0 var(--space-4); padding: 0 0 0 var(--space-3); border-left: 2px solid var(--color-bg-line); }
.sub { color: var(--color-ink-faint); font-size: var(--font-size-body-s); }
/* «5 з 3» — перебір коралловым (`32` §12 п. 1): привязка не блокируется, но видно сразу */
.sub.over { color: var(--color-coral-ink); font-weight: 700; }
@media (max-width: 480px) {
  .kids { margin-left: var(--space-2); padding-left: var(--space-2); }
  .icons { margin-left: 0; }
}
</style>
