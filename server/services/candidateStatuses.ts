import { and, asc, eq, sql } from 'drizzle-orm'
import { candidateStatuses, users } from '../db/schema'
import { withTenant } from '../utils/withTenant'
import { SYSTEM_CANDIDATE_STATUSES } from '../../shared/enums'
import type { CandidateState } from '../../shared/enums'
import type { CandidateStatusCreateInput, CandidateStatusUpdateInput } from '../../shared/schemas/candidates'
import { recordAudit } from './audit'
import type { Ctx } from './candidates'

/**
 * Справочник колонок воронки — `/settings/candidate-statuses` (docs/v2/28 §3.3, §5.4, §10).
 *
 * Справочник расширяемый, но каждая колонка обязана назвать `maps_to`: отчётность, лимиты и
 * уведомления смотрят на ось `candidate_state`, интерфейс — на колонку, и связывает их только
 * это поле (§4.1). Колонка без него разваливает отчёт по воронке, как только тенант заведёт
 * «Передзвонити у січні», — поэтому `maps_to` обязателен уже в zod, а не «по договорённости».
 *
 * Системные шесть (`is_system`) заводятся при инициализации тенанта
 * (`server/db/tenantDefaults.ts`) и догоняющей вставкой миграции `0064_v2_candidates`:
 * их нельзя удалить и нельзя переименовать `code`; название, цвет и порядок — можно (§3.3).
 */

export interface StatusRow {
  id: string
  code: string
  nameUk: string
  nameEn: string | null
  color: string
  sort: number
  isSystem: boolean
  mapsTo: CandidateState
  isActive: boolean
  /** Сколько кандидатов стоит в колонке — счётчик экрана §5.4 и предупреждение перед удалением. */
  total: number
}

/** Список колонок с числом кандидатов в каждой (§5.4, §10 `GET /candidate-statuses`). */
export async function listStatuses(ctx: Ctx, opts: { onlyActive?: boolean } = {}): Promise<StatusRow[]> {
  return withTenant(ctx.tenantId, ctx.actorId, async (tx) => {
    const rows = await tx.select({
      id: candidateStatuses.id,
      code: candidateStatuses.code,
      nameUk: candidateStatuses.nameUk,
      nameEn: candidateStatuses.nameEn,
      color: candidateStatuses.color,
      sort: candidateStatuses.sort,
      isSystem: candidateStatuses.isSystem,
      mapsTo: candidateStatuses.mapsTo,
      isActive: candidateStatuses.isActive,
      // Кандидаты в колонке — подзапросом с явным `kind`: сотрудников в колонке канбана быть
      // не может, и фильтр здесь не формальность, а то самое «вид назван явно» (В-8).
      total: sql<number>`(select count(*)::int from users u where u.candidate_status_id = ${candidateStatuses.id} and u.kind = 'candidate')`,
    }).from(candidateStatuses)
      .where(opts.onlyActive ? eq(candidateStatuses.isActive, true) : undefined)
      .orderBy(asc(candidateStatuses.sort)) as unknown as StatusRow[]
    return rows
  })
}

export type StatusCreateResult =
  | { ok: true, status: StatusRow }
  | { ok: false, code: 'code_exists' }

export async function createStatus(ctx: Ctx, input: CandidateStatusCreateInput): Promise<StatusCreateResult> {
  return withTenant(ctx.tenantId, ctx.actorId, async (tx) => {
    const [exists] = await tx.select({ id: candidateStatuses.id }).from(candidateStatuses).where(eq(candidateStatuses.code, input.code))
    if (exists) return { ok: false, code: 'code_exists' } as StatusCreateResult
    const [maxSort] = await tx.select({ n: sql<number>`coalesce(max(${candidateStatuses.sort}), -1)::int` }).from(candidateStatuses)
    const [row] = await tx.insert(candidateStatuses).values({
      tenantId: ctx.tenantId,
      code: input.code,
      nameUk: input.nameUk,
      nameEn: input.nameEn ?? null,
      color: input.color,
      mapsTo: input.mapsTo,
      sort: input.sort ?? Number(maxSort?.n ?? -1) + 1,
      isSystem: false,
      createdBy: ctx.actorId,
    }).returning()
    await recordAudit(tx, {
      tenantId: ctx.tenantId,
      actorId: ctx.actorId,
      action: 'candidate_status.create',
      entity: 'candidate_status',
      entityId: row!.id,
      after: { code: row!.code, mapsTo: row!.mapsTo },
    })
    return { ok: true, status: { ...(row as unknown as StatusRow), total: 0 } } as StatusCreateResult
  })
}

export type StatusUpdateResult =
  | { ok: true, status: StatusRow }
  | { ok: false, code: 'not_found' }
  | { ok: false, code: 'system_readonly' }

/**
 * Правка колонки (§10 `PATCH /candidate-statuses/:id`). У системной меняются название, цвет,
 * порядок и активность; `maps_to` у неё — нет: поменять терминальное состояние «Відхилені»
 * значит переписать смысл всех отчётов задним числом.
 */
export async function updateStatus(ctx: Ctx, id: string, input: CandidateStatusUpdateInput): Promise<StatusUpdateResult> {
  return withTenant(ctx.tenantId, ctx.actorId, async (tx) => {
    const [row] = await tx.select().from(candidateStatuses).where(eq(candidateStatuses.id, id))
    if (!row) return { ok: false, code: 'not_found' }
    if (row.isSystem && input.mapsTo && input.mapsTo !== row.mapsTo) return { ok: false, code: 'system_readonly' }
    await tx.update(candidateStatuses).set({
      ...(input.nameUk === undefined ? {} : { nameUk: input.nameUk }),
      ...(input.nameEn === undefined ? {} : { nameEn: input.nameEn }),
      ...(input.color === undefined ? {} : { color: input.color }),
      ...(input.mapsTo === undefined ? {} : { mapsTo: input.mapsTo }),
      ...(input.sort === undefined ? {} : { sort: input.sort }),
      ...(input.isActive === undefined ? {} : { isActive: input.isActive }),
      updatedAt: new Date(),
    }).where(eq(candidateStatuses.id, id))
    await recordAudit(tx, {
      tenantId: ctx.tenantId,
      actorId: ctx.actorId,
      action: 'candidate_status.update',
      entity: 'candidate_status',
      entityId: id,
      before: { nameUk: row.nameUk, color: row.color, mapsTo: row.mapsTo, sort: row.sort, isActive: row.isActive },
      after: input,
    })
    const [updated] = await tx.select().from(candidateStatuses).where(eq(candidateStatuses.id, id))
    return { ok: true, status: { ...(updated as unknown as StatusRow), total: await countIn(tx, id) } }
  })
}

export type StatusDeleteResult =
  | { ok: true }
  | { ok: false, code: 'not_found' }
  | { ok: false, code: 'system_readonly' }
  | { ok: false, code: 'in_use', candidates: { id: string, fullName: string }[] }

/**
 * Удаление колонки (§10 `DELETE /candidate-statuses/:id`, критерий §13 к. 6).
 *
 * Системную удалить нельзя — `403 status.system`. Пользовательскую с кандидатами внутри тоже:
 * `409 candidate_status.in_use` со списком, чтобы было кого переносить. Молчаливое обнуление
 * `candidate_status_id` (а именно так сработал бы `on delete set null`) оставило бы кандидатов
 * без колонки — живых людей, невидимых на доске.
 */
export async function deleteStatus(ctx: Ctx, id: string): Promise<StatusDeleteResult> {
  return withTenant(ctx.tenantId, ctx.actorId, async (tx) => {
    const [row] = await tx.select().from(candidateStatuses).where(eq(candidateStatuses.id, id))
    if (!row) return { ok: false, code: 'not_found' }
    if (row.isSystem) return { ok: false, code: 'system_readonly' }
    const inside = await tx.select({ id: users.id, fullName: users.fullName })
      .from(users)
      .where(and(eq(users.candidateStatusId, id), eq(users.kind, 'candidate')))
      .limit(50) as unknown as { id: string, fullName: string }[]
    if (inside.length) return { ok: false, code: 'in_use', candidates: inside }
    await tx.delete(candidateStatuses).where(eq(candidateStatuses.id, id))
    await recordAudit(tx, {
      tenantId: ctx.tenantId,
      actorId: ctx.actorId,
      action: 'candidate_status.delete',
      entity: 'candidate_status',
      entityId: id,
      before: { code: row.code, nameUk: row.nameUk, mapsTo: row.mapsTo },
    })
    return { ok: true }
  })
}

async function countIn(tx: Parameters<typeof recordAudit>[0], statusId: string): Promise<number> {
  const [r] = await tx.execute(sql`select count(*)::int as n from users where candidate_status_id = ${statusId}::uuid and kind = 'candidate'`) as unknown as { n: number }[]
  return Number(r?.n ?? 0)
}

/** Код системной колонки → её строка в тенанте; нужен посеву и авто-переходам (§4.3, PR-14). */
export function systemStatusCodes(): string[] {
  return SYSTEM_CANDIDATE_STATUSES.map(s => s.code)
}
