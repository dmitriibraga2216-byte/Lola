import { describe, expect, it } from 'vitest'
import { PLACEMENT_FIX_LINK, placementHints, type PlacementLists } from '../../shared/domain/personPlacement'

/**
 * Замечание 27.09, п. 4: «Місто», «Точка», «Посада» обязательны (docs/16 §6.1), а списки «—» —
 * сохранить нельзя, и форма не говорит почему. Подсказка называет причину и ведёт туда, где
 * справочник заполняется.
 */
const full: PlacementLists = { failed: {}, cities: 2, units: 1, locations: 3, unitLocations: 3, orgUnitSelected: false, positions: 5 }

describe('подсказки размещения в форме человека', () => {
  it('всё заполнено — подсказок нет', () => {
    expect(placementHints(full)).toEqual({})
  })

  it('пустые справочники тенанта — «empty» у каждого поля', () => {
    expect(placementHints({ ...full, cities: 0, locations: 0, unitLocations: 0, positions: 0 }))
      .toEqual({ cityId: 'empty', locationId: 'empty', positionId: 'empty' })
  })

  it('у выбранного подразделения нет своих точек — отдельная подсказка', () => {
    expect(placementHints({ ...full, orgUnitSelected: true, unitLocations: 0 })).toEqual({ locationId: 'unit_has_no_locations' })
  })

  it('не загрузился справочник — «load_failed», а не «пусто»', () => {
    expect(placementHints({ ...full, failed: { positions: true }, positions: 0 })).toEqual({ positionId: 'load_failed' })
  })

  it('ссылки: города и должности — справочники (с вкладкой), подразделения и точки — оргструктура', () => {
    expect(PLACEMENT_FIX_LINK).toEqual({ cityId: '/admin/refs?kind=cities', positionId: '/admin/refs?kind=positions', orgUnitId: '/admin/org', locationId: '/admin/org' })
  })
})
