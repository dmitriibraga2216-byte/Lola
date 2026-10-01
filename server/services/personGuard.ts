import { sql } from 'drizzle-orm'
import { OWNER_ONLY_SCOPES } from '../../shared/domain/roles'
import { withTenant } from '../utils/withTenant'
import { areaCovers, areaOf, hasTenantGrant, type Access } from './access'

/**
 * Право действовать над **конкретным** человеком (security-sweep-1). `requireScope` отвечает «есть ли
 * скоуп хоть где-то»; здесь — «покрывает ли он этого человека и не шире ли права цели прав actor'а».
 *
 * 1. **Область.** Скоуп на точку/подразделение действует только на людей своей области (основная
 *    точка). Грант на весь тенант — на всех.
 * 2. **Захват учётки.** Вход, контакты и доступ (телефон, почта, статус, блокировка, Telegram,
 *    приглашение) чужого человека меняет только тот, у кого есть все его права: иначе руководитель
 *    точки или методист, сменив администратору телефон, входил бы за него по коду. Исключение —
 *    `role.assign` на весь тенант (администратор, владелец): он и так раздаёт роли, — но права
 *    владельца (`OWNER_ONLY_SCOPES`) и через него не захватываются.
 */
export interface PersonGuardOpts {
  /** Меняются вход, контакты или доступ человека — проверка «не шире ли права цели». */
  sensitive?: boolean
}

export type PersonGuardResult = { ok: true } | { ok: false, code: 'not_found' | 'out_of_area' | 'privileged' }

/** Набор скоупов, которые у actor'а есть хоть где-то (активная роль сессии или токен). */
function heldScopes(access: Access): Set<string> {
  return new Set(access.grants.flatMap(g => g.scopes))
}

/** Скоупы всех действующих ролей человека (не только активной — сменить роль он может сам). */
async function targetScopes(access: Access, personId: string): Promise<string[]> {
  const rows = await withTenant(access.tenantId, access.userId, tx => tx.execute(sql`
    select distinct unnest(r.scopes) as scope from user_roles ur join roles r on r.id = ur.role_id
    where ur.user_id = ${personId}::uuid and (ur.valid_until is null or ur.valid_until > now())
  `)) as unknown as { scope: string }[]
  return rows.map(r => r.scope)
}

/** Что из прав цели не покрывает actor; пусто — можно. */
export async function privilegeGap(access: Access, personId: string): Promise<string[]> {
  if (personId === access.userId) return []
  const held = heldScopes(access)
  const missing = (await targetScopes(access, personId)).filter(s => !held.has(s))
  if (!missing.length) return []
  if (hasTenantGrant(access, 'role.assign')) return missing.filter(s => (OWNER_ONLY_SCOPES as readonly string[]).includes(s))
  return missing
}

export async function checkPersonAccess(access: Access, scope: string, personId: string, opts: PersonGuardOpts = {}): Promise<PersonGuardResult> {
  if (!/^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i.test(personId)) return { ok: false, code: 'not_found' }
  const [person] = await withTenant(access.tenantId, access.userId, tx => tx.execute(sql`
    select u.id, (select p.location_id from user_placements p
                  where p.user_id = u.id and p.ended_at is null
                  order by p.is_primary desc, p.started_at desc limit 1) as location_id
    from users u where u.id = ${personId}::uuid
  `)) as unknown as { id: string, location_id: string | null }[]
  if (!person) return { ok: false, code: 'not_found' }
  if (personId !== access.userId && !areaCovers(await areaOf(access, scope), person.location_id)) return { ok: false, code: 'out_of_area' }
  if (opts.sensitive && (await privilegeGap(access, personId)).length) return { ok: false, code: 'privileged' }
  return { ok: true }
}

/** Для эндпоинтов `people/[id]/*`: 404 — человека нет, 403 — вне области или права цели шире. */
export async function assertPersonAccess(access: Access, scope: string, personId: string, opts: PersonGuardOpts = {}): Promise<void> {
  const r = await checkPersonAccess(access, scope, personId, opts)
  if (r.ok) return
  if (r.code === 'not_found') throw createError({ statusCode: 404, data: { code: 'not_found', message: 'Людину не знайдено' } })
  if (r.code === 'out_of_area') throw createError({ statusCode: 403, data: { code: 'forbidden', message: 'Людина поза вашою областю. Зверніться до адміністратора' } })
  throw createError({ statusCode: 403, data: { code: 'person.privileged', message: 'У цієї людини ширші права, ніж у вас. Вхід, контакти й доступ їй змінює адміністратор' } })
}

/**
 * Можно ли выдать роль (security-sweep-1): `role.assign` на весь тенант — любую (кроме владения, его
 * отсекает `assignRole`). Иначе — только себе подобную: все скоупы роли есть у actor'а, область
 * назначения внутри его области `role.assign`, и не себе — как у `createRole` (`scope_not_owned`).
 */
export async function checkRoleAssign(access: Access, personId: string, input: { roleCode: string, scopeType: 'tenant' | 'org_unit' | 'location', scopeId?: string | null }): Promise<boolean> {
  if (hasTenantGrant(access, 'role.assign')) return true
  if (personId === access.userId || input.scopeType === 'tenant' || !input.scopeId) return false
  const [role] = await withTenant(access.tenantId, access.userId, tx => tx.execute(sql`
    select scopes from roles where code = ${input.roleCode}
  `)) as unknown as { scopes: string[] }[]
  if (!role) return true // нет роли — ответит `assignRole` (404)
  const held = heldScopes(access)
  if (role.scopes.some(s => !held.has(s))) return false
  const area = await areaOf(access, 'role.assign')
  if (input.scopeType === 'location') return areaCovers(area, input.scopeId)
  return access.grants.some(g => g.scopeType === 'org_unit' && g.scopeId === input.scopeId && g.scopes.includes('role.assign'))
}
