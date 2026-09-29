/**
 * Подсказки у обязательных полей размещения в форме человека (docs/16 §6.1: Місто, Підрозділ,
 * Точка, Посада — ✓). Замечание администратора 27.09: списки «—», сохранить нельзя, и форма
 * не говорит почему. Пустой список — это либо пустой справочник тенанта (его надо заполнить
 * на экране справочников/оргструктуры), либо у выбранного подразделения нет своих точек,
 * либо справочник не загрузился.
 */
export type PlacementField = 'cityId' | 'orgUnitId' | 'locationId' | 'positionId'
export type PlacementHint = 'load_failed' | 'empty' | 'unit_has_no_locations'

export interface PlacementLists {
  /** Справочник, запрос которого не удался. */
  failed: Partial<Record<'cities' | 'units' | 'locations' | 'positions', boolean>>
  cities: number
  units: number
  locations: number
  /** Точек у выбранного подразделения (без выбора — все). */
  unitLocations: number
  orgUnitSelected: boolean
  positions: number
}

export function placementHints(l: PlacementLists): Partial<Record<PlacementField, PlacementHint>> {
  const out: Partial<Record<PlacementField, PlacementHint>> = {}
  const one = (field: PlacementField, key: keyof PlacementLists['failed'], count: number) => {
    if (l.failed[key]) out[field] = 'load_failed'
    else if (count === 0) out[field] = 'empty'
  }
  one('cityId', 'cities', l.cities)
  one('orgUnitId', 'units', l.units)
  one('locationId', 'locations', l.locations)
  one('positionId', 'positions', l.positions)
  if (!out.locationId && l.orgUnitSelected && l.unitLocations === 0) out.locationId = 'unit_has_no_locations'
  return out
}

/** Где заполнить справочник поля: города и должности — «Довідники», подразделения и точки — «Оргструктура». */
export const PLACEMENT_FIX_LINK: Record<PlacementField, string> = {
  cityId: '/admin/refs?kind=cities',
  orgUnitId: '/admin/org',
  locationId: '/admin/org',
  positionId: '/admin/refs?kind=positions',
}
