<script setup lang="ts">
/**
 * Зіставлення посад і ролей (docs/28 «Паритет 4» отк. (2), docs/24 §3.4.1 «Режим призначення
 * ролей: Зіставлення посад», D-001): просте правило «посада → роль», що застосовується при
 * зміні посади й імпорті (`applyPositionRoles`). Кнопка «Перезібрати ролі по мережі» викликає
 * те саме правило одразу для всіх людей — не чекаючи наступної зміни посади.
 */
definePageMeta({ layout: 'admin', middleware: 'admin-scope', requiredScope: 'settings.tenant' })
const { t } = useI18n()
const { api } = useApi()

interface Ref { id: string, name: string }
interface Role { id: string, code: string, name: string }
interface MapItem { positionId: string, positionName: string, roleId: string, roleCode: string, roleName: string, scopeType: 'tenant' | 'org_unit' | 'location', scopeId: string | null }
interface Row { positionId: string, roleCode: string, scopeType: 'tenant' | 'org_unit' | 'location', scopeId: string | null }

const items = ref<MapItem[]>([])
const positions = ref<Ref[]>([])
const roles = ref<Role[]>([])
const locations = ref<Ref[]>([])
const orgUnits = ref<Ref[]>([])
const rows = ref<Row[]>([])
const error = ref('')
const saved = ref(false)
const reapplying = ref(false)
const reapplyResult = ref<{ users: number, granted: number, revoked: number } | null>(null)

function toRows(list: MapItem[]): Row[] {
  return list.map(m => ({ positionId: m.positionId, roleCode: m.roleCode, scopeType: m.scopeType, scopeId: m.scopeId }))
}

async function load() {
  const [map, pos, r, locs, units] = await Promise.all([
    api<MapItem[]>('/settings/position-role-map'),
    api<Ref[]>('/refs/positions'),
    api<Role[]>('/settings/roles'),
    api<Ref[]>('/refs/locations'),
    api<Ref[]>('/refs/org-units'),
  ])
  items.value = map
  positions.value = pos
  roles.value = r
  locations.value = locs
  orgUnits.value = units
  rows.value = toRows(map)
  saved.value = false
}
onMounted(load)

function addRow() {
  rows.value.push({ positionId: positions.value[0]?.id ?? '', roleCode: roles.value[0]?.code ?? '', scopeType: 'location', scopeId: null })
  saved.value = false
}
function removeRow(i: number) { rows.value.splice(i, 1); saved.value = false }
function onScopeTypeChange(row: Row) { row.scopeId = null; saved.value = false }

const canSave = computed(() => rows.value.every(r => r.positionId && r.roleCode))

async function save() {
  error.value = ''; saved.value = false
  try {
    await api('/settings/position-role-map', { method: 'PUT', body: { items: rows.value.map(r => ({ positionId: r.positionId, roleCode: r.roleCode, scopeType: r.scopeType, scopeId: r.scopeType === 'tenant' ? null : (r.scopeId || null) })) } })
    await load()
    saved.value = true
  }
  catch (err) { error.value = apiErrorOf(err).message }
}

async function reapply() {
  error.value = ''; reapplyResult.value = null; reapplying.value = true
  try { reapplyResult.value = await api('/settings/position-role-map/reapply', { method: 'POST' }) }
  catch (err) { error.value = apiErrorOf(err).message }
  finally { reapplying.value = false }
}
</script>

<template>
  <div>
    <PageHeader :title="t('settings.positionRoleMap.title')" :crumbs="[{ label: t('admin.section.settings') }, { label: t('settings.positionRoleMap.title') }]">
      <template #actions>
        <button class="btn ghost" type="button" :disabled="reapplying" @click="reapply">{{ reapplying ? t('common.loading') : t('settings.positionRoleMap.reapply') }}</button>
        <button class="btn primary" type="button" :disabled="!canSave" @click="save">{{ t('common.save') }}</button>
      </template>
    </PageHeader>
    <p class="help">{{ t('settings.positionRoleMap.hint') }}</p>
    <p v-if="error" class="error-text" role="alert">{{ error }}</p>
    <p v-if="saved" class="note teal" role="status">{{ t('common.saved') }}</p>
    <p v-if="reapplyResult" class="note teal" role="status">{{ t('settings.positionRoleMap.reapplyDone', reapplyResult) }}</p>

    <div class="table-wrap card">
      <table class="table">
        <thead>
          <tr>
            <th>{{ t('settings.positionRoleMap.position') }}</th>
            <th>{{ t('settings.positionRoleMap.role') }}</th>
            <th>{{ t('settings.positionRoleMap.scope') }}</th>
            <th>{{ t('settings.positionRoleMap.scopeValue') }}</th>
            <th />
          </tr>
        </thead>
        <tbody>
          <tr v-for="(row, i) in rows" :key="i">
            <td>
              <select v-model="row.positionId" class="field" :aria-label="t('settings.positionRoleMap.position')" @change="saved = false">
                <option v-for="p in positions" :key="p.id" :value="p.id">{{ p.name }}</option>
              </select>
            </td>
            <td>
              <select v-model="row.roleCode" class="field" :aria-label="t('settings.positionRoleMap.role')" @change="saved = false">
                <option v-for="r in roles" :key="r.code" :value="r.code">{{ r.name }}</option>
              </select>
            </td>
            <td>
              <select v-model="row.scopeType" class="field" :aria-label="t('settings.positionRoleMap.scope')" @change="onScopeTypeChange(row)">
                <option value="tenant">{{ t('settings.scopeTypes.tenant') }}</option>
                <option value="location">{{ t('settings.scopeTypes.location') }}</option>
                <option value="org_unit">{{ t('settings.scopeTypes.org_unit') }}</option>
              </select>
            </td>
            <td>
              <select v-if="row.scopeType !== 'tenant'" v-model="row.scopeId" class="field" :aria-label="t('settings.positionRoleMap.scopeValue')" @change="saved = false">
                <option :value="null">{{ t('settings.positionRoleMap.scopePlacement') }}</option>
                <option v-for="l in (row.scopeType === 'location' ? locations : orgUnits)" :key="l.id" :value="l.id">{{ l.name }}</option>
              </select>
              <span v-else class="muted">—</span>
            </td>
            <td><button class="btn ghost small" type="button" :aria-label="t('common.delete')" @click="removeRow(i)">×</button></td>
          </tr>
          <tr v-if="!rows.length"><td colspan="5" class="muted">{{ t('settings.positionRoleMap.empty') }}</td></tr>
        </tbody>
      </table>
    </div>
    <button class="btn ghost small top" type="button" :disabled="!positions.length || !roles.length" @click="addRow">{{ t('settings.positionRoleMap.addRow') }}</button>
  </div>
</template>

<style scoped>
.table-wrap { margin-top: var(--space-3); overflow-x: auto; }
.table select.field { min-width: 160px; }
.top { margin-top: var(--space-3); }
</style>
