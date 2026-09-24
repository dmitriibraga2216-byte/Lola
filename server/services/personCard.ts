import { sql } from 'drizzle-orm'
import { users } from '../db/schema'
import type { TenantTx } from '../utils/withTenant'
import { personById } from './repo/people'

/**
 * Человек, о котором заметки и документы карточки (docs/v2/38-people-extensions.md §5.1).
 *
 * Только сотрудник: у кандидата своя служебная переписка (`candidate_comments`, `v2/28` §3.5)
 * и своего кадрового дела нет — для него блоки карточки сотрудника отвечают `404`. Вид людей
 * проверяется явно (инвариант 17), выборка — по первичному ключу через `personById()`.
 *
 * `locationId` — точка **текущего** основного размещения: по ней руководитель точки получает
 * доступ, и при переводе доступ прежнего пропадает в тот же день (§7.4). `positionIds` — посады
 * всех действующих размещений: по ним обязательный документ «для посад» примеряется к человеку
 * (§7.8), совместитель обязан иметь документы обеих посад.
 */
export interface CardSubject {
  id: string
  fullName: string
  archived: boolean
  locationId: string | null
  positionIds: string[]
}

/** Идентификатор из пути: не-uuid — такого человека (заметки, документа) нет, `404`, а не `500`. */
export function isUuid(v: string | undefined | null): v is string {
  return !!v && /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i.test(v)
}

export async function cardSubject(tx: TenantTx, personId: string): Promise<CardSubject | null> {
  if (!isUuid(personId)) return null
  const [p] = await personById(tx, { id: users.id, kind: users.kind, status: users.status, fullName: users.fullName }, personId)
  if (!p || p.kind !== 'employee') return null
  const placements = await tx.execute(sql`
    select location_id, position_id, is_primary from user_placements
    where user_id = ${personId}::uuid and ended_at is null
    order by is_primary desc, started_at desc`) as unknown as { location_id: string, position_id: string, is_primary: boolean }[]
  const primary = placements.find(r => r.is_primary)
  return {
    id: p.id,
    fullName: p.fullName,
    archived: p.status === 'archived',
    locationId: primary?.location_id ?? null,
    positionIds: [...new Set(placements.map(r => r.position_id))],
  }
}
