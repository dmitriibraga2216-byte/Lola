import { readFileSync } from 'node:fs'
import { resolve } from 'node:path'
import { describe, expect, it } from 'vitest'
import {
  ENUMS, ORG_ASSIGNMENT_END_REASONS, ORG_ASSIGNMENT_ROLES, ORG_CONFLICT_KINDS,
  ORG_CONFLICT_SEVERITIES, ORG_MANAGER_SOURCES, ORG_NODE_STATES, ORG_NODE_TYPES, ORG_SNAPSHOT_KINDS,
} from '../../shared/enums'
import { orgNodeCreateSchema, orgNodeMoveSchema, orgNodeTitleSchema } from '../../shared/schemas/orgStructure'

/**
 * PR-30: правила дерева подчинения и перечни, которые их описывают
 * (`docs/v2/32-org-structure.md` §3, §7; решение `docs/v2/44-decisions.md` В-7).
 *
 * Поведение дерева в БД проверяет `tests/integration/v2-org-structure.spec.ts`; здесь —
 * то, что можно проверить без базы: состав перечней, контракты форм и карта кодов ошибок.
 * Смысл этих проверок в том, что **перечень один**: второй список видов конфликта или
 * второе написание того же значения ломает отчёт молча, а не падением.
 */

const root = resolve(__dirname, '../..')

describe('В-7: один перечень видов конфликта из десяти значений', () => {
  it('пять существующих значений сохранены без изменений', () => {
    for (const kind of ['double_unit', 'placement_replaced', 'manager_self', 'manager_cycle', 'unit_missing']) {
      expect(ORG_CONFLICT_KINDS, `потеряно существующее значение ${kind}`).toContain(kind)
    }
  })

  it('пять новых значений пакета добавлены', () => {
    for (const kind of ['no_manager', 'manager_mismatch', 'depth_exceeded', 'dismissed_holder', 'position_mismatch']) {
      expect(ORG_CONFLICT_KINDS, `не добавлено значение ${kind}`).toContain(kind)
    }
  })

  /**
   * Три имени пакета отброшены как переименования существующих (`44` В-7). Если они
   * появятся, один и тот же конфликт получит два имени и в отчёте станет двумя строками.
   */
  it('три пакетных имени-дубля в перечень не попали', () => {
    for (const [dup, existing] of [['self_manager', 'manager_self'], ['multi_primary', 'double_unit'], ['orphan_user', 'unit_missing']]) {
      expect(ORG_CONFLICT_KINDS as readonly string[], `${dup} — переименование ${existing}, а не новый вид`).not.toContain(dup)
    }
  })

  it('ровно десять значений, без дублей', () => {
    expect(ORG_CONFLICT_KINDS.length).toBe(10)
    expect(new Set(ORG_CONFLICT_KINDS).size).toBe(10)
  })

  it('важность взята у security_severity, а не заведена своей парой error | warning', () => {
    expect([...ORG_CONFLICT_SEVERITIES]).toEqual(['info', 'warning', 'critical'])
    expect(ORG_CONFLICT_SEVERITIES as readonly string[]).not.toContain('error')
  })
})

describe('перечни оргструктуры зарегистрированы как все остальные (правило 13)', () => {
  const doc = readFileSync(resolve(root, 'docs/02-data-model.md'), 'utf8')
  const section = doc.split('## Перечисления, снятые с эталона')[1]?.split('\n## ')[0] ?? ''

  const registered: [string, readonly string[]][] = [
    ['org_conflict_kind', ORG_CONFLICT_KINDS],
    ['org_conflict_severity', ORG_CONFLICT_SEVERITIES],
    ['org_node_type', ORG_NODE_TYPES],
    ['org_node_state', ORG_NODE_STATES],
    ['org_assignment_role', ORG_ASSIGNMENT_ROLES],
    ['org_assignment_end_reason', ORG_ASSIGNMENT_END_REASONS],
    ['org_manager_source', ORG_MANAGER_SOURCES],
    ['org_snapshot_kind', ORG_SNAPSHOT_KINDS],
  ]

  it.each(registered)('%s объявлен в shared/enums.ts и описан в docs/02', (name, values) => {
    expect(ENUMS[name], `перечисление ${name} не зарегистрировано в ENUMS`).toBeDefined()
    expect([...ENUMS[name]!]).toEqual([...values])
    expect(section, `перечисление ${name} не описано в docs/02 §«Перечисления»`).toContain(`${name}:`)
  })
})

describe('приоритет источников руководителя (docs/v2/32 §7.8)', () => {
  /**
   * Порядок значений — это и есть порядок шагов: дерево, точка, роль в области, никого.
   * `functional` стоит между «точкой» и «ролью» как зарезервированное значение отчёта:
   * функциональный руководитель в цепочку **не входит** (`32` §7.8), но колонка
   * «Джерело керівника» умеет его показать, если он когда-нибудь туда попадёт.
   */
  it('первый шаг — дерево, последний — «никого»', () => {
    expect(ORG_MANAGER_SOURCES[0]).toBe('org_tree')
    expect(ORG_MANAGER_SOURCES[ORG_MANAGER_SOURCES.length - 1]).toBe('none')
  })

  it('резервный шаг — точка, и он идёт раньше роли в области', () => {
    expect(ORG_MANAGER_SOURCES.indexOf('location')).toBeLessThan(ORG_MANAGER_SOURCES.indexOf('role_scope'))
  })
})

describe('форма узла (docs/v2/32 §6.1)', () => {
  it('подпись — от 2 до 120 знаков', () => {
    expect(orgNodeTitleSchema.safeParse('А').success).toBe(false)
    expect(orgNodeTitleSchema.safeParse('Шеф-кухар').success).toBe(true)
    expect(orgNodeTitleSchema.safeParse('я'.repeat(121)).success).toBe(false)
  })

  it('угловые скобки в подписи запрещены — карточка узла показывает её как есть', () => {
    expect(orgNodeTitleSchema.safeParse('<b>Шеф</b>').success).toBe(false)
  })

  it('плановая численность — от 1 до 999', () => {
    expect(orgNodeCreateSchema.safeParse({ title: 'Кухарі', headcountPlanned: 0 }).success).toBe(false)
    expect(orgNodeCreateSchema.safeParse({ title: 'Кухарі', headcountPlanned: 3 }).success).toBe(true)
    expect(orgNodeCreateSchema.safeParse({ title: 'Кухарі', headcountPlanned: 1000 }).success).toBe(false)
  })

  it('вид узла — только position или employee, третьего нет', () => {
    expect(orgNodeCreateSchema.safeParse({ title: 'Кухарі', type: 'unit' }).success).toBe(false)
    expect(orgNodeCreateSchema.safeParse({ title: 'Кухарі', type: 'employee' }).success).toBe(true)
  })

  it('перемещение к корню — parentId явный null, а не пропуск поля', () => {
    expect(orgNodeMoveSchema.safeParse({}).success).toBe(false)
    expect(orgNodeMoveSchema.safeParse({ parentId: null }).success).toBe(true)
  })
})

describe('коды ошибок дерева → HTTP (docs/v2/32 §10)', () => {
  it('каждый код отображён, чужое — 404, а не 403 (правило 15)', async () => {
    const { ORG_ERROR_STATUS, MAX_DEPTH } = await import('../../server/services/orgStructure')
    expect(ORG_ERROR_STATUS.not_found).toBe(404)
    expect(ORG_ERROR_STATUS.cycle_detected).toBe(409)
    expect(ORG_ERROR_STATUS.depth_exceeded).toBe(409)
    expect(ORG_ERROR_STATUS.validation_failed).toBe(422)
    expect(Object.values(ORG_ERROR_STATUS).every(s => s >= 400 && s < 500)).toBe(true)
    expect(MAX_DEPTH).toBe(12)
  })
})
