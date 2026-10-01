import { and, eq, inArray, sql } from 'drizzle-orm'
import { orgNodeAssignments, orgNodes, users } from '../db/schema'
import { withTenant } from '../utils/withTenant'
import { USER_KINDS } from '../../shared/enums'
import { listTree } from './orgStructure'

/**
 * Кэш витрины оргструктуры (`GET /org-structure/tree?mode=view`, docs/v2/32 §7 п. 7, `44` Р-CC.6).
 *
 * Витрина живёт в памяти процесса 5 минут, ключ — «тенант × флаги». Чтобы правка дерева была
 * видна сразу (и на другом экземпляре приложения), запись сверяется с отметкой структуры:
 * последний `updated_at` и число строк узлов и назначений. Изменилось дерево — витрина
 * строится заново. Переименование должности, точки или человека отметку не трогает и
 * появляется в пределах 5 минут — это и есть кэш, о котором говорит ТЗ.
 *
 * Скрытие человека (`users.is_hidden`) — приватность, ждать ему нельзя: при каждой выдаче
 * из кэша скрытые сейчас держатели вычёркиваются заново. Конструктор (`mode=admin`) не кэшируется.
 */

export const ORG_VIEW_CACHE_TTL_MS = 5 * 60_000
const MAX_ENTRIES = 500

type Tree = Awaited<ReturnType<typeof listTree>>
interface Holder { userId: string }
interface ViewNode { holders: Holder[], headcountActual: number, children: ViewNode[] }
interface Entry { at: number, stamp: string, tree: Tree }

const cache = new Map<string, Entry>()

/** Для тестов: сбросить кэш целиком. */
export function clearOrgViewCache(): void {
  cache.clear()
}

export async function listViewTreeCached(
  ctx: { tenantId: string, actorId: string },
  opts: { includeArchived?: boolean, includeVacant?: boolean },
  now = Date.now(),
): Promise<Tree & { cached: boolean }> {
  const key = `${ctx.tenantId}|${opts.includeArchived ? 1 : 0}|${opts.includeVacant === false ? 0 : 1}`
  const { stamp, hidden } = await withTenant(ctx.tenantId, ctx.actorId, async (tx) => {
    const [n] = await tx.select({ m: sql<string>`coalesce(max(${orgNodes.updatedAt})::text, '')`, c: sql<number>`count(*)::int` }).from(orgNodes).where(eq(orgNodes.tenantId, ctx.tenantId))
    const [a] = await tx.select({ m: sql<string>`coalesce(max(${orgNodeAssignments.updatedAt})::text, '')`, c: sql<number>`count(*)::int` }).from(orgNodeAssignments).where(eq(orgNodeAssignments.tenantId, ctx.tenantId))
    // Держателем узла бывает человек любого вида — скрытие действует на оба (правило 17: kind явно)
    const h = await tx.select({ id: users.id }).from(users).where(and(eq(users.tenantId, ctx.tenantId), inArray(users.kind, [...USER_KINDS]), eq(users.isHidden, true)))
    return { stamp: `${n!.m}:${n!.c}|${a!.m}:${a!.c}`, hidden: new Set(h.map(r => r.id)) }
  })
  const hit = cache.get(key)
  if (hit && hit.stamp === stamp && now - hit.at < ORG_VIEW_CACHE_TTL_MS) {
    return { ...hit.tree, nodes: stripHidden(hit.tree.nodes as ViewNode[], hidden), cached: true }
  }
  const tree = await listTree(ctx, { mode: 'view', includeArchived: opts.includeArchived, includeVacant: opts.includeVacant })
  cache.delete(key)
  cache.set(key, { at: now, stamp, tree })
  if (cache.size > MAX_ENTRIES) cache.delete(cache.keys().next().value!)
  return { ...tree, cached: false }
}

/** Новые объекты, кэш не меняется: держатель, скрытый после сборки витрины, в ответ не попадает. */
function stripHidden(nodes: ViewNode[], hidden: Set<string>): ViewNode[] {
  if (hidden.size === 0) return nodes
  return nodes.map((n) => {
    const holders = n.holders.filter(h => !hidden.has(h.userId))
    return { ...n, holders, headcountActual: holders.length, children: stripHidden(n.children, hidden) }
  })
}
