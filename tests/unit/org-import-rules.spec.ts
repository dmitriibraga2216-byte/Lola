import { describe, expect, it } from 'vitest'
import {
  ORG_IMPORT_COLUMNS, applyOrgMapping, guessOrgMapping, parseCsv, parseFlag, planOrgImport, snapshotForced, toCsv,
} from '../../shared/domain/orgImport'
import type { OrgImportColumn, OrgImportExistingNode, OrgImportInput, OrgImportPerson } from '../../shared/domain/orgImport'
import { descendantsOf, layoutTree, orgNodeLabel } from '../../shared/domain/orgLayout'

/**
 * Правила импорта оргструктуры в чистом виде (docs/v2/32 §6.2, §7 п. 7, §9, §12 п. 3; PR-31).
 *
 * Главное условие выхода PR-31 — **кривой файл не ломает инвариант дерева**: петли, висячие
 * узлы, тринадцатый уровень и одиннадцатый корень отклоняются построчно и становятся
 * конфликтами, а итоговая раскладка всегда выводится из родителей. Здесь это проверяется без
 * базы; что сервис пишет ровно план — в `tests/integration/v2-org-import.spec.ts`.
 */

let seq = 0
const uid = () => `00000000-0000-4000-8000-${String(++seq).padStart(12, '0')}`

function existingNode(over: Partial<OrgImportExistingNode> & { id: string, parentId: string | null, path: string }): OrgImportExistingNode {
  return {
    externalKey: null,
    archived: false,
    type: 'position',
    title: 'Вузол',
    positionId: null,
    orgUnitId: null,
    locationId: null,
    headcountPlanned: 1,
    isManagerPoint: false,
    sort: 0,
    activeHolders: 0,
    ...over,
  }
}

type Row = Partial<Record<OrgImportColumn, string>>

function plan(rows: Row[], over: Partial<OrgImportInput> = {}) {
  const people = new Map<string, OrgImportPerson>([
    ['E1', { id: 'u-1', archived: false }],
    ['E2', { id: 'u-2', archived: false }],
    ['E3', { id: 'u-3', archived: true }],
  ])
  return planOrgImport({
    rows: rows.map((values, i) => ({ line: i + 2, values })),
    existing: [],
    refs: { positions: new Map([['кухар', 'pos-1']]), inactivePositions: new Set(['старша посада']), orgUnits: new Map([['кухня', 'unit-1']]), locations: new Map([['точка а', 'loc-1']]), inactiveLocations: new Set() },
    person: ref => people.get(ref) ?? null,
    options: { createPositions: false, archiveMissing: false },
    newId: () => uid(),
    ...over,
  })
}

const errorsOf = (p: ReturnType<typeof plan>, line: number) => p.rows.find(r => r.line === line)!.errors.map(e => e.code)
const warningsOf = (p: ReturnType<typeof plan>, line: number) => p.rows.find(r => r.line === line)!.warnings.map(e => e.code)

describe('CSV: разбор и выгрузка (`32` §9)', () => {
  it('BOM, `;`, кавычки с разделителем и переводом строки внутри, CRLF, пустые строки', () => {
    const csv = '\uFEFFexternal_key;title\r\nA;"Кухарі; зміна 1"\r\n\r\nB;"Рядок\nдругий"\r\nC;"Лапки ""так"""\r\n'
    const { headers, rows } = parseCsv(csv)
    expect(headers).toEqual(['external_key', 'title'])
    expect(rows).toEqual([['A', 'Кухарі; зміна 1'], ['B', 'Рядок\nдругий'], ['C', 'Лапки "так"']])
  })

  it('разделитель — из заголовка: запятая, если `;` там нет; запятая в `;`-файле — часть значения', () => {
    expect(parseCsv('external_key,title\nA,Кухня\n').rows).toEqual([['A', 'Кухня']])
    expect(parseCsv('external_key;title\nA;Кухарі, зміна 1\n').rows).toEqual([['A', 'Кухарі, зміна 1']])
  })

  it('выгрузка разбирается обратно без потерь: формулы обезврежены апострофом, импорт его снимает', () => {
    const csv = toCsv([['external_key', 'title', 'employee_external_id', 'sort'], ['k1', '=HYPERLINK("x")', '+380670000001', -1], ['k2', 'Кухарі; зміна 1', null, 0]])
    expect(csv.startsWith('\uFEFF')).toBe(true)
    const { headers, rows } = parseCsv(csv)
    expect(rows[0]).toEqual(['k1', '\'=HYPERLINK("x")', '\'+380670000001', '-1'])
    const p = plan(rows.map(r => applyOrgMapping(Object.fromEntries(headers.map((h, i) => [h, r[i]!])), guessOrgMapping(headers))))
    expect(p.nodes.find(n => n.key === 'k1')!.title).toBe('=HYPERLINK("x")')
    expect(p.nodes.find(n => n.key === 'k1')!.sort).toBe(-1)
  })

  it('сопоставление колонок: формат выгрузки целиком, украинские заголовки — по синонимам', () => {
    const exact = guessOrgMapping([...ORG_IMPORT_COLUMNS])
    expect(Object.values(exact).sort()).toEqual([...ORG_IMPORT_COLUMNS].sort())
    expect(guessOrgMapping(['Ключ', 'Батьківський ключ', 'Назва', 'Посада', 'Філія', 'Керівна точка'])).toEqual({
      'Ключ': 'external_key', 'Батьківський ключ': 'parent_external_key', 'Назва': 'title',
      'Посада': 'position_name', 'Філія': 'location_name', 'Керівна точка': 'is_manager_point',
    })
  })

  it('флаги: так/ні, true/false, 1/0; пусто — не задано; непонятное — ошибка', () => {
    expect(parseFlag('Так')).toBe(true)
    expect(parseFlag('false')).toBe(false)
    expect(parseFlag('')).toBeNull()
    expect(parseFlag('можливо')).toBeUndefined()
  })

  it('снимок перед импортом обязателен, если строк больше 50 (`32` §6.2)', () => {
    expect(snapshotForced(50)).toBe(false)
    expect(snapshotForced(51)).toBe(true)
  })
})

describe('раскладка дерева', () => {
  it('путь ребёнка = путь родителя + метка, уровень на один глубже', () => {
    const r = layoutTree([{ id: 'a', parentId: null }, { id: 'b', parentId: 'a' }, { id: 'c', parentId: 'b' }])
    expect(r.ok).toBe(true)
    if (!r.ok) return
    expect(r.layout.get('c')).toEqual({ path: `${orgNodeLabel('a')}.${orgNodeLabel('b')}.${orgNodeLabel('c')}`, depth: 3 })
  })

  it('петля, оборванный родитель и тринадцатый уровень — проблемы, а не раскладка', () => {
    const chain = Array.from({ length: 13 }, (_, i) => ({ id: `d${i}`, parentId: i ? `d${i - 1}` : null }))
    const r = layoutTree([{ id: 'x', parentId: 'y' }, { id: 'y', parentId: 'x' }, { id: 'z', parentId: 'nope' }, ...chain])
    expect(r.ok).toBe(false)
    if (r.ok) return
    expect(r.problems).toEqual(expect.arrayContaining([
      { kind: 'cycle', ids: expect.arrayContaining(['x', 'y']) },
      { kind: 'missing_parent', id: 'z', parentId: 'nope' },
      { kind: 'depth_exceeded', id: 'd12', depth: 13 },
    ]))
  })

  it('потомки узла — для «разом з N підлеглими вузлами»', () => {
    expect(descendantsOf([{ id: 'a', parentId: null }, { id: 'b', parentId: 'a' }, { id: 'c', parentId: 'b' }, { id: 'd', parentId: null }], 'a').sort()).toEqual(['b', 'c'])
  })
})

describe('план импорта: структура', () => {
  it('новое дерево из трёх уровней — родители раньше детей, пути выводятся из родителей', () => {
    const p = plan([
      { external_key: 'B', parent_external_key: 'A', title: 'Кухня' },
      { external_key: 'A', title: 'Директор', is_manager_point: 'так' },
      { external_key: 'C', parent_external_key: 'B', title: 'Кухарі', headcount_planned: '3' },
    ])
    expect(p.stats).toMatchObject({ total: 3, create: 3, errors: 0 })
    expect(p.nodes.map(n => n.key)).toEqual(['A', 'B', 'C'])
    const [a, b, c] = p.nodes
    expect(b!.path).toBe(`${a!.path}.${orgNodeLabel(b!.id)}`)
    expect(c!.depth).toBe(3)
    expect(a!.isManagerPoint).toBe(true)
    expect(c!.headcountPlanned).toBe(3)
    expect(p.conflicts).toEqual([])
  })

  it('висячий узел: родителя нет — ошибка и конфликт unit_missing, его потомки — тоже висячие', () => {
    const p = plan([
      { external_key: 'A', title: 'Корінь' },
      { external_key: 'D', parent_external_key: 'X', title: 'Сирота' },
      { external_key: 'E', parent_external_key: 'D', title: 'Онук сироти' },
    ])
    expect(errorsOf(p, 3)).toEqual(['parent_not_found'])
    expect(errorsOf(p, 4)).toEqual(['parent_rejected'])
    expect(p.nodes.map(n => n.key)).toEqual(['A'])
    expect(p.conflicts.map(c => [c.key, c.kind, c.details.reason])).toEqual([['D', 'unit_missing', 'parent_not_found'], ['E', 'unit_missing', 'parent_rejected']])
  })

  it('петля A → B → A: обе строки в ошибки, конфликт manager_cycle; остальное применяется (`32` §12 п. 3)', () => {
    const p = plan([
      { external_key: 'R', title: 'Корінь' },
      { external_key: 'A', parent_external_key: 'B', title: 'Вузол А' },
      { external_key: 'B', parent_external_key: 'A', title: 'Вузол Б' },
      { external_key: 'K', parent_external_key: 'A', title: 'Дитина А' },
    ])
    expect(errorsOf(p, 3)).toEqual(['cycle'])
    expect(errorsOf(p, 4)).toEqual(['cycle'])
    expect(errorsOf(p, 5)).toEqual(['parent_rejected'])
    expect(p.nodes.map(n => n.key)).toEqual(['R'])
    expect(p.conflicts.filter(c => c.kind === 'manager_cycle').map(c => c.key).sort()).toEqual(['A', 'B'])
    expect(p.rows.find(r => r.line === 3)!.errors[0]!.params!.keys).toMatch(/A → B → A|B → A → B/)
  })

  it('узел — родитель сам себе: manager_self', () => {
    const p = plan([{ external_key: 'A', parent_external_key: 'A', title: 'Сам собі' }])
    expect(errorsOf(p, 2)).toEqual(['self_parent'])
    expect(p.conflicts).toEqual([expect.objectContaining({ kind: 'manager_self', severity: 'critical' })])
  })

  it('цепочка из 13 уровней: тринадцатый отклонён depth_exceeded, четырнадцатый висит', () => {
    const rows: Row[] = Array.from({ length: 14 }, (_, i) => ({ external_key: `L${i + 1}`, parent_external_key: i ? `L${i}` : '', title: `Рівень ${i + 1}` }))
    const p = plan(rows)
    expect(p.nodes).toHaveLength(12)
    expect(errorsOf(p, 14)).toEqual(['depth_exceeded'])
    expect(errorsOf(p, 15)).toEqual(['parent_rejected'])
    expect(Math.max(...p.nodes.map(n => n.depth))).toBe(12)
  })

  it('перенос существующей ветки ниже 12-го уровня отклоняется целиком — ветка остаётся на месте', () => {
    // Существующая ветка высотой 5: X(1) → … → X5; файл тащит X под новый узел 10-го уровня.
    const ids = Array.from({ length: 5 }, () => uid())
    let path = ''
    const existing = ids.map((id, i) => {
      path = i ? `${path}.${orgNodeLabel(id)}` : orgNodeLabel(id)
      return existingNode({ id, parentId: i ? ids[i - 1]! : null, path, externalKey: `X${i + 1}` })
    })
    const chain: Row[] = Array.from({ length: 10 }, (_, i) => ({ external_key: `N${i + 1}`, parent_external_key: i ? `N${i}` : '', title: `Новий ${i + 1}` }))
    const p = plan([...chain, { external_key: 'X1', parent_external_key: 'N10', title: 'Вузол' }], { existing })
    expect(errorsOf(p, 12)).toEqual(['depth_exceeded'])
    expect(p.nodes).toHaveLength(10)
    expect(p.relaid).toEqual([])
  })

  it('петля через существующий узел: файл подчиняет узел его же потомку — строка отклонена', () => {
    const x = uid()
    const y = uid()
    const existing = [
      existingNode({ id: x, parentId: null, path: orgNodeLabel(x), externalKey: 'X' }),
      existingNode({ id: y, parentId: x, path: `${orgNodeLabel(x)}.${orgNodeLabel(y)}`, externalKey: 'Y' }),
    ]
    const p = plan([{ external_key: 'X', parent_external_key: 'Y', title: 'Вузол' }], { existing })
    expect(errorsOf(p, 2)).toEqual(['cycle'])
    expect(p.nodes).toEqual([])
  })

  it('перенос существующего узла: путь его и потомков пересчитан, потомки вне файла — в relaid', () => {
    const [a, b, c, d] = [uid(), uid(), uid(), uid()]
    const la = orgNodeLabel(a)
    const existing = [
      existingNode({ id: a, parentId: null, path: la, externalKey: 'A', title: 'Вузол' }),
      existingNode({ id: b, parentId: null, path: orgNodeLabel(b), externalKey: 'B', title: 'Вузол' }),
      existingNode({ id: c, parentId: b, path: `${orgNodeLabel(b)}.${orgNodeLabel(c)}`, externalKey: 'C', title: 'Вузол' }),
      existingNode({ id: d, parentId: c, path: `${orgNodeLabel(b)}.${orgNodeLabel(c)}.${orgNodeLabel(d)}`, title: 'Вузол' }),
    ]
    const p = plan([{ external_key: 'C', parent_external_key: 'A', title: 'Вузол' }], { existing })
    const moved = p.nodes[0]!
    expect(moved.action).toBe('update')
    expect(moved.changed).toEqual(['parent'])
    expect(moved.path).toBe(`${la}.${orgNodeLabel(c)}`)
    expect(p.relaid).toEqual([{ id: d, path: `${la}.${orgNodeLabel(c)}.${orgNodeLabel(d)}`, depth: 3 }])
  })

  it('одиннадцатый корень отклоняется; с «Архівувати відсутні» старые корни уходят и место есть', () => {
    const existing = Array.from({ length: 10 }, () => uid()).map((id, i) => existingNode({ id, parentId: null, path: orgNodeLabel(id), externalKey: `OLD${i}` }))
    const p = plan([{ external_key: 'NEW', title: 'Новий корінь' }], { existing })
    expect(errorsOf(p, 2)).toEqual(['too_many_roots'])
    const q = plan([{ external_key: 'NEW', title: 'Новий корінь' }], { existing, options: { createPositions: false, archiveMissing: true } })
    expect(errorsOf(q, 2)).toEqual([])
    expect(q.archive).toHaveLength(10)
  })

  it('повторный импорт того же — «без змін», узел находится и по id (выгрузка узла без ключа)', () => {
    const a = uid()
    const existing = [existingNode({ id: a, parentId: null, path: orgNodeLabel(a), title: 'Директор', isManagerPoint: true, positionId: 'pos-1' })]
    const p = plan([{ external_key: a, title: 'Директор', is_manager_point: 'true', position_name: 'Кухар' }], { existing })
    expect(p.nodes[0]).toMatchObject({ id: a, action: 'same', externalKey: null, isNew: false })
    expect(p.stats).toMatchObject({ create: 0, update: 0, same: 1 })
  })

  it('узел из архива возвращается файлом; под архивным родителем, которого нет в файле, — висячий', () => {
    const [a, b] = [uid(), uid()]
    const existing = [
      existingNode({ id: a, parentId: null, path: orgNodeLabel(a), externalKey: 'A', archived: true }),
      existingNode({ id: b, parentId: null, path: orgNodeLabel(b), externalKey: 'B', archived: true }),
    ]
    const p = plan([
      { external_key: 'A', title: 'Вузол' },
      { external_key: 'K', parent_external_key: 'B', title: 'Під архівним' },
    ], { existing })
    expect(p.nodes[0]).toMatchObject({ key: 'A', restore: true, action: 'update', changed: ['state'] })
    expect(errorsOf(p, 3)).toEqual(['parent_archived'])
  })

  it('«Архівувати відсутні» не трогает узел, под которым остаётся живой узел', () => {
    const [m, c] = [uid(), uid()]
    const existing = [
      existingNode({ id: m, parentId: null, path: orgNodeLabel(m), externalKey: 'M' }),
      existingNode({ id: c, parentId: m, path: `${orgNodeLabel(m)}.${orgNodeLabel(c)}`, externalKey: 'C' }),
    ]
    // Строка C с ошибкой: узел C остаётся как есть под M. M в файле нет, но архивировать его
    // нельзя — под ним живой узел; это видно счётчиком `archiveBlocked`, а не молчанием.
    const p = plan([{ external_key: 'C', title: 'x' }], { existing, options: { createPositions: false, archiveMissing: true } })
    expect(errorsOf(p, 2)).toEqual(['title_invalid'])
    expect(p.archive).toEqual([])
    expect(p.stats.archiveBlocked).toBe(1)
  })
})

describe('план импорта: поля и справочники', () => {
  it('ошибки полей: без ключа, неизвестный вид, подпись, план именного узла, дата, флаг', () => {
    const p = plan([
      { title: 'Без ключа' },
      { external_key: 'A', type: 'відділ', title: 'Вузол' },
      { external_key: 'B', title: '<b>' },
      { external_key: 'C', type: 'employee', title: 'Шеф', headcount_planned: '2' },
      { external_key: 'D', title: 'Вузол', employee_external_id: 'E1', assignment_started_at: '2026-02-30' },
      { external_key: 'E', title: 'Вузол', is_manager_point: 'можливо' },
    ])
    expect(errorsOf(p, 2)).toEqual(['key_required'])
    expect(errorsOf(p, 3)).toEqual(['type_invalid'])
    expect(errorsOf(p, 4)).toEqual(['title_invalid'])
    expect(errorsOf(p, 5)).toEqual(['headcount_named'])
    expect(errorsOf(p, 6)).toEqual(['date_invalid'])
    expect(errorsOf(p, 7)).toEqual(['flag_invalid'])
    expect(p.conflicts).toEqual([])
  })

  it('посада: неизвестная — ошибка, с «Створювати відсутні посади» — будет заведена; неактивная — ошибка', () => {
    const rows: Row[] = [{ external_key: 'A', position_name: 'Сомельє' }, { external_key: 'B', position_name: 'сомельє' }, { external_key: 'C', position_name: 'Старша посада' }]
    const off = plan(rows)
    expect(errorsOf(off, 2)).toEqual(['position_not_found'])
    const on = plan(rows, { options: { createPositions: true, archiveMissing: false } })
    expect(on.positionsToCreate).toEqual(['Сомельє'])
    expect(on.nodes.map(n => [n.key, n.title, n.newPositionName])).toEqual([['A', 'Сомельє', 'Сомельє'], ['B', 'сомельє', 'Сомельє']])
    expect(warningsOf(on, 2)).toEqual(['position_created'])
    expect(errorsOf(on, 4)).toEqual(['position_inactive'])
  })

  it('підрозділ і філія — только из справочника', () => {
    const p = plan([{ external_key: 'A', title: 'Вузол', org_unit_name: 'Кухня', location_name: 'Точка А' }, { external_key: 'B', title: 'Вузол', location_name: 'Невідома' }])
    expect(p.nodes[0]).toMatchObject({ orgUnitId: 'unit-1', locationId: 'loc-1' })
    expect(errorsOf(p, 3)).toEqual(['location_not_found'])
  })
})

describe('план импорта: люди', () => {
  it('несколько строк одного ключа — держатели одного узла; расходящиеся колонки узла — ошибка строки', () => {
    const p = plan([
      { external_key: 'K', title: 'Кухарі', headcount_planned: '3', employee_external_id: 'E1' },
      { external_key: 'K', employee_external_id: 'E2', assignment_role: 'заступник' },
      { external_key: 'K', title: 'Інша назва', employee_external_id: 'E1' },
    ])
    expect(p.nodes).toHaveLength(1)
    expect(p.assignments.map(a => [a.userId, a.role, a.isPrimary])).toEqual([['u-1', 'holder', true], ['u-2', 'deputy', true]])
    expect(errorsOf(p, 4)).toEqual(['row_conflict'])
  })

  it('именной узел — один человек; уволенный и неизвестный не привязываются, узел создаётся', () => {
    const p = plan([
      { external_key: 'N', type: 'employee', title: 'Шеф', employee_external_id: 'E1' },
      { external_key: 'N', employee_external_id: 'E2' },
      { external_key: 'M', title: 'Кухарі', employee_external_id: 'E3' },
      { external_key: 'Q', title: 'Кухарі', employee_external_id: 'NOPE' },
    ])
    expect(warningsOf(p, 3)).toEqual(['named_second_holder'])
    expect(warningsOf(p, 4)).toEqual(['employee_archived'])
    expect(warningsOf(p, 5)).toEqual(['employee_not_found'])
    expect(p.assignments.map(a => a.userId)).toEqual(['u-1'])
    expect(p.nodes.map(n => n.key)).toEqual(['N', 'M', 'Q'])
  })

  it('основное подчинение одно: первое упоминание — основное, дальше — сумісництво; явное основное побеждает', () => {
    const p = plan([
      { external_key: 'A', title: 'Вузол А', employee_external_id: 'E1' },
      { external_key: 'B', title: 'Вузол Б', employee_external_id: 'E1' },
      { external_key: 'C', title: 'Вузол В', employee_external_id: 'E2' },
      { external_key: 'D', title: 'Вузол Г', employee_external_id: 'E2', assignment_is_primary: 'true' },
      { external_key: 'F', title: 'Вузол Д', employee_external_id: 'E2', assignment_is_primary: 'true' },
    ])
    const of = (key: string) => p.assignments.find(a => a.key === key)
    expect(of('A')!.isPrimary).toBe(true)
    expect(of('B')!.isPrimary).toBe(false)
    expect(warningsOf(p, 3)).toEqual(['secondary_assignment'])
    expect(of('C')!.isPrimary).toBe(false)
    expect(of('D')!.isPrimary).toBe(true)
    expect(of('F')).toBeUndefined()
    expect(warningsOf(p, 6)).toEqual(['primary_twice'])
  })

  it('строки отклонённого узла не привязывают людей', () => {
    const p = plan([
      { external_key: 'A', parent_external_key: 'X', title: 'Сирота', employee_external_id: 'E1' },
      { external_key: 'A', employee_external_id: 'E2' },
    ])
    expect(errorsOf(p, 3)).toEqual(['node_rejected'])
    expect(p.assignments).toEqual([])
  })
})
