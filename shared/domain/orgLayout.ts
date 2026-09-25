/**
 * Раскладка дерева подчинения в пути `ltree` (docs/v2/32-org-structure.md §3.2, §7 п. 1–2).
 *
 * Модуль не знает о базе: импорт CSV и откат к снимку (PR-31) сначала решают, **у кого какой
 * родитель будет**, а пути и уровни всех узлов выводятся отсюда одним проходом. Так инвариант
 * триггера `org_nodes_guard` (путь ребёнка = путь родителя плюс собственная метка, ровно на
 * уровень глубже) соблюдается по построению, а не проверкой после записи: ни один набор
 * родителей, прошедший `layoutTree()`, не может дать ни петли, ни «висячего» узла, ни
 * тринадцатого уровня.
 */

/** Максимальная глубина дерева (`32` §7 п. 1, Г-32.5; констрейнт `org_nodes_size_chk`). */
export const ORG_MAX_DEPTH = 12
/** Корней не больше десяти на тенант (`32` §7 п. 1 [решение]). Архивные не считаются. */
export const ORG_MAX_ROOTS = 10
/** Перемещение больше стольких узлов — «массовое»: перед ним снимок `pre_bulk_move` (`32` §7 п. 7). */
export const ORG_BULK_MOVE_SNAPSHOT_NODES = 20

/**
 * Метка `ltree` узла: буквы, цифры и подчёркивание. Берётся id узла — он уникален и не
 * меняется, поэтому два разных узла не могут получить одинаковый путь ни в каком состоянии,
 * даже промежуточном посреди перемещения ветки (`unique (tenant_id, path)` не краснеет).
 */
export function orgNodeLabel(id: string): string {
  return `n${id.replace(/-/g, '')}`
}

export interface LayoutInput {
  id: string
  parentId: string | null
}

export interface LayoutResult {
  path: string
  depth: number
}

export type LayoutProblem =
  | { kind: 'cycle', ids: string[] }
  | { kind: 'missing_parent', id: string, parentId: string }
  | { kind: 'depth_exceeded', id: string, depth: number }

/**
 * Пути и уровни всех узлов по указателям на родителя.
 *
 * Возвращает либо раскладку целиком, либо **все** найденные проблемы: петли (каждая один раз,
 * перечнем узлов), ссылки на несуществующего родителя, узлы глубже `ORG_MAX_DEPTH`. При
 * проблемах раскладка частичная — только для разрешимых узлов, и писать по ней нельзя:
 * вызывающий обязан сначала решить, что делать с проблемными узлами (импорт отклоняет строку,
 * откат отцепляет узел в архивный корень), и позвать функцию снова.
 */
export function layoutTree(nodes: readonly LayoutInput[], maxDepth = ORG_MAX_DEPTH): { ok: true, layout: Map<string, LayoutResult> } | { ok: false, problems: LayoutProblem[], layout: Map<string, LayoutResult> } {
  const parentOf = new Map(nodes.map(n => [n.id, n.parentId]))
  const layout = new Map<string, LayoutResult>()
  const problems: LayoutProblem[] = []
  const inCycle = new Set<string>()
  const broken = new Set<string>()

  for (const start of parentOf.keys()) {
    if (layout.has(start) || inCycle.has(start) || broken.has(start)) continue
    // Подъём до известного узла, корня или повтора; путь подъёма запоминается, чтобы
    // раздать результат всем его звеньям за один проход.
    const trail: string[] = []
    const onTrail = new Map<string, number>()
    let cur: string | null = start
    let base: LayoutResult | null = null
    let fail = false
    while (cur !== null) {
      if (layout.has(cur)) { base = layout.get(cur)!; break }
      if (inCycle.has(cur) || broken.has(cur)) { fail = true; break }
      const seen = onTrail.get(cur)
      if (seen !== undefined) {
        const ring = trail.slice(seen)
        ring.forEach(id => inCycle.add(id))
        problems.push({ kind: 'cycle', ids: ring })
        fail = true
        break
      }
      onTrail.set(cur, trail.length)
      trail.push(cur)
      const parent = parentOf.get(cur)
      if (parent === undefined) { fail = true; break } // сюда попадает только стартовый узел без записи — не бывает
      if (parent !== null && !parentOf.has(parent)) {
        problems.push({ kind: 'missing_parent', id: cur, parentId: parent })
        broken.add(cur)
        fail = true
        break
      }
      cur = parent
    }
    if (fail) {
      // Всё, что висит на петле или на оборванной ветке, раскладки не получает.
      for (const id of trail) if (!inCycle.has(id)) broken.add(id)
      continue
    }
    // Спуск обратно: от ближайшего разложенного предка (или от корня) к стартовому узлу.
    for (let i = trail.length - 1; i >= 0; i--) {
      const id = trail[i]!
      const label = orgNodeLabel(id)
      const r: LayoutResult = base ? { path: `${base.path}.${label}`, depth: base.depth + 1 } : { path: label, depth: 1 }
      layout.set(id, r)
      base = r
    }
  }

  for (const [id, r] of layout) if (r.depth > maxDepth) problems.push({ kind: 'depth_exceeded', id, depth: r.depth })
  return problems.length ? { ok: false, problems, layout } : { ok: true, layout }
}

/** Потомки узла (без него самого) по указателям на родителя — для подсчёта «N підлеглих вузлів». */
export function descendantsOf(nodes: readonly LayoutInput[], id: string): string[] {
  const kids = new Map<string, string[]>()
  for (const n of nodes) {
    if (n.parentId === null) continue
    kids.set(n.parentId, [...(kids.get(n.parentId) ?? []), n.id])
  }
  const out = new Set<string>()
  const stack = [...(kids.get(id) ?? [])]
  while (stack.length) {
    const cur = stack.pop()!
    if (out.has(cur) || cur === id) continue
    out.add(cur)
    stack.push(...(kids.get(cur) ?? []))
  }
  return [...out]
}
