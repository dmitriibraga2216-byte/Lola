<script setup lang="ts">
/** Узел дерева оргструктуры для админа (docs/16 §5.3): подразделение → точки, счётчики, перетаскивание. */
interface Unit { id: string, name: string, parentId: string | null }
interface Loc { id: string, name: string, orgUnitId: string, isActive: boolean }
const props = defineProps<{ unit: Unit, units: Unit[], locs: Loc[], counts: Record<string, number>, selected: { kind: 'unit' | 'location', id: string } | null, canEdit: boolean, dragOver: string | null }>()
const emit = defineEmits<{ select: [kind: 'unit' | 'location', id: string], dragStart: [kind: 'unit' | 'location', id: string, e: DragEvent], dropOn: [unitId: string], dragOver: [id: string | null] }>()
const { t } = useI18n()
const open = ref(true)
const children = computed(() => props.units.filter(u => u.parentId === props.unit.id))
const locations = computed(() => props.locs.filter(l => l.orgUnitId === props.unit.id))
const isSel = (kind: 'unit' | 'location', id: string) => props.selected?.kind === kind && props.selected.id === id
</script>

<template>
  <div class="node">
    <div
      :class="['unit', { sel: isSel('unit', unit.id), over: dragOver === unit.id }]"
      :draggable="canEdit"
      @dragstart="emit('dragStart', 'unit', unit.id, $event)"
      @dragover.prevent="emit('dragOver', unit.id)"
      @dragleave="emit('dragOver', null)"
      @drop.prevent="emit('dropOn', unit.id)"
    >
      <button class="tgl" :aria-expanded="open" :aria-label="unit.name" @click="open = !open">{{ open ? '▾' : '▸' }}</button>
      <button class="name" @click="emit('select', 'unit', unit.id)">{{ unit.name }}</button>
      <span class="cnt">{{ t('orgAdmin.peopleCount', { n: counts[unit.id] ?? 0 }) }}</span>
    </div>
    <ul v-if="open" class="kids">
      <li v-for="l in locations" :key="l.id">
        <div :class="['loc', { sel: isSel('location', l.id), off: !l.isActive }]" :draggable="canEdit" @dragstart="emit('dragStart', 'location', l.id, $event)">
          <button class="name" @click="emit('select', 'location', l.id)">📍 {{ l.name }}</button>
          <span class="cnt">{{ t('orgAdmin.peopleCount', { n: counts[l.id] ?? 0 }) }}</span>
        </div>
      </li>
      <li v-for="c in children" :key="c.id">
        <OrgAdminNode :unit="c" :units="units" :locs="locs" :counts="counts" :selected="selected" :can-edit="canEdit" :drag-over="dragOver" @select="(k, id) => emit('select', k, id)" @drag-start="(k, id, e) => emit('dragStart', k, id, e)" @drop-on="id => emit('dropOn', id)" @drag-over="id => emit('dragOver', id)" />
      </li>
    </ul>
  </div>
</template>

<style scoped>
.node { min-width: 0; }
.unit, .loc { display: flex; align-items: center; gap: var(--space-2); padding: var(--space-1) var(--space-2); border-radius: var(--radius-s); }
.unit { font-weight: 800; }
.unit.over { outline: 2px dashed var(--color-sun); }
.sel { background: var(--color-sun); }
.off { opacity: 0.5; }
.tgl, .name { font: inherit; border: none; background: transparent; cursor: pointer; color: var(--color-ink); padding: 0; text-align: left; }
.name { font-weight: inherit; flex: 1; min-width: 0; overflow-wrap: anywhere; }
.cnt { font-size: var(--font-size-body-s); color: var(--color-ink-faint); white-space: nowrap; }
.kids { list-style: none; margin: 0; padding: 0 0 0 var(--space-4); border-left: 1px solid var(--color-bg-line-soft); }
</style>
