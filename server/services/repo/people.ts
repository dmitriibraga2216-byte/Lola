import { and, eq, sql } from 'drizzle-orm'
import type { SQL } from 'drizzle-orm'
import { users } from '../../db/schema'
import type { TenantTx } from '../../utils/withTenant'
import type { UserKind } from '../../../shared/enums'

/**
 * Репозиторий людей — слой 1 патча П-16.1 (docs/v2/39-patches.md, решение docs/v2/44-decisions.md В-8).
 *
 * Кандидат и сотрудник — одна запись `users` с разным `kind` (инвариант пакета, docs/v2/28 §2).
 * Значит **любая списочная выборка людей обязана назвать вид явно**: забытый фильтр не падает,
 * а молча возвращает кандидатов в списки сотрудников, в адресаты рассылок и в оплачиваемый
 * счётчик (docs/v2/42-stages-delta.md §7.1 — главный риск пакета).
 *
 * Три слоя защиты, ни один не работает в одиночку:
 *   1. этот файл — единственный разрешённый путь к `users` для списков людей;
 *   2. `tests/integration/users-kind-filter.spec.ts` — сканер исходников с поимённым allowlist:
 *      новая выборка мимо репозитория красит гейт;
 *   3. канареечный кандидат в посеве (`server/db/seed.ts`) — то, что сканер пропустил,
 *      видно лишней строкой в ответе.
 *
 * Чего здесь нет и не будет: подключения к драйверу. Репозиторий отдаёт условия и построители
 * поверх транзакции `withTenant()` (CLAUDE.md правило 2) — тенант берётся из сессии, не отсюда.
 *
 * Точечные выборки (`eq(users.id, …)`, join ради ФИО) фильтра не получают осознанно: фильтровать
 * выборку по первичному ключу бессмысленно, а обогащение именем корректно для обоих видов людей.
 * Для них есть `personById()` — с тем же смыслом, но с именем, по которому видно намерение.
 */

export const EMPLOYEE: UserKind = 'employee'
export const CANDIDATE: UserKind = 'candidate'

/** Условие Drizzle «только сотрудники» плюс переданные условия выборки. */
export function employeeOnly(...conds: (SQL | undefined)[]): SQL {
  return and(eq(users.kind, EMPLOYEE), ...conds)!
}

/** Условие Drizzle «только кандидаты» плюс переданные условия выборки. */
export function candidateOnly(...conds: (SQL | undefined)[]): SQL {
  return and(eq(users.kind, CANDIDATE), ...conds)!
}

type Columns = Parameters<TenantTx['select']>[0]

/**
 * Список сотрудников: `select … from users where kind = 'employee' and …`.
 * Для выборок с join-ами берите `employeeOnly()` в `.where()` — Drizzle не даёт
 * дописать join после `.where()`, и обёртка над билдером тут только мешала бы.
 */
export function employees<T extends Columns>(tx: TenantTx, columns: T, ...conds: (SQL | undefined)[]) {
  return tx.select(columns).from(users).where(employeeOnly(...conds))
}

/** Список кандидатов: `select … from users where kind = 'candidate' and …`. */
export function candidates<T extends Columns>(tx: TenantTx, columns: T, ...conds: (SQL | undefined)[]) {
  return tx.select(columns).from(users).where(candidateOnly(...conds))
}

/**
 * Один человек по первичному ключу — **без** фильтра вида, намеренно: карточка, ФИО в журнале,
 * проверка прав и вход работают одинаково для сотрудника и кандидата. Вид, если он важен
 * вызывающему, читается колонкой `kind` и проверяется явно.
 */
export function personById<T extends Columns>(tx: TenantTx, columns: T, id: string) {
  return tx.select(columns).from(users).where(eq(users.id, id))
}

/** Фрагмент сырого SQL: `and u.kind = 'employee'`. Алиас по умолчанию — `u` (соглашение каркаса отчётов). */
export function EMPLOYEES_ONLY(alias = 'u'): SQL {
  return sql`and ${IS_EMPLOYEE(alias)}`
}

/** Фрагмент сырого SQL: `and u.kind = 'candidate'`. */
export function CANDIDATES_ONLY(alias = 'u'): SQL {
  return sql`and ${IS_CANDIDATE(alias)}`
}

/** Голый предикат для сырого SQL: `u.kind = 'employee'`; пустой алиас — колонка без префикса. */
export function IS_EMPLOYEE(alias = 'u'): SQL {
  return sql`${sql.raw(alias ? `${alias}.` : '')}kind = 'employee'`
}

/** Голый предикат для сырого SQL: `u.kind = 'candidate'`. */
export function IS_CANDIDATE(alias = 'u'): SQL {
  return sql`${sql.raw(alias ? `${alias}.` : '')}kind = 'candidate'`
}

/**
 * Фрагмент сырого SQL «только действующие сотрудники»: `and (u.kind = 'employee' and
 * u.status = 'active' and not u.is_blocked)`.
 *
 * Своего условия «уволен» здесь нет — это ровно та отметка, которую ставит офбординг PR-07
 * (`completeOffboarding()`: `status = 'archived'`, docs/v2/33 §7.7) и блокировка входа
 * (`is_blocked`), и ровно то условие, по которому считается ось лимита `users_active`
 * (`usageCounters.ts`): уволенный не занимает места в тарифе — и не получает работу.
 * Маршрутизация жалоб (docs/v2/36 §7.5 б–д, критерий 8) спрашивает «кому отдать карточку»
 * именно так, чтобы уволенный автор не блокировал очередь.
 */
export function ACTIVE_EMPLOYEES_ONLY(alias = 'u'): SQL {
  const p = sql.raw(alias ? `${alias}.` : '')
  return sql`and (${p}kind = 'employee' and ${p}status = 'active' and not ${p}is_blocked)`
}

/**
 * Фрагмент сырого SQL «сотрудники, кроме уволенных»: `and (u.kind = 'employee' and
 * u.status <> 'archived')`. Уволенный — ровно та отметка, что ставит офбординг PR-07
 * (`status = 'archived'`); приглашённый, ещё не входивший, уволенным не считается.
 * Нужен адресатам ответа на их же обращение: «заявитель уволен до закрытия — уведомление не
 * отправляется» (docs/v2/36 §12), а приглашённому — отправляется.
 */
export function NOT_ARCHIVED_EMPLOYEES_ONLY(alias = 'u'): SQL {
  const p = sql.raw(alias ? `${alias}.` : '')
  return sql`and (${p}kind = 'employee' and ${p}status <> 'archived')`
}
