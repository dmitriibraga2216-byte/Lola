import { eq, sql } from 'drizzle-orm'
import { platformAudit, tenantLimits, tenants } from '../db/schema'
import { withTenant, type TenantTx } from '../utils/withTenant'
import { recordAudit } from './audit'
import { enqueueNotification } from './notifications'
import { billingRecipients } from './limitNotices'
import { invalidateLimits, type SubscriptionState } from './tenantLimits'
import { localDate } from './personDocuments'
import { defaultDictionary } from './translations'

/**
 * Автопереход подписки `active → grace → readonly` (docs/v2/35-billing-limits.md §4, §7.8 п. 3–4,
 * §11 `billing.grace_scan`, критерий §13 к. 5).
 *
 * **Даты ведёт оператор вручную** (решение владельца по вопросу 17, `docs/v2/44` В-21): платёжного
 * провайдера нет, `paid_until` двигает платёж, записанный в консоли (`recordTenantPayment`), —
 * он же возвращает `active` из любого состояния (§7.8 п. 6, к. 6). Здесь только обратное
 * направление: срок прошёл — статус опускается сам, без участия оператора.
 *
 * - `active`, `paid_until` раньше сегодняшнего дня → `grace`, `grace_until = paid_until + GRACE_DAYS`
 *   (если оператор не поставил свою дату позже `paid_until`), уведомление `plan_grace_started`.
 * - `grace`, `grace_until` раньше сегодняшнего дня → `readonly`, уведомление `plan_readonly`.
 * - `trial`, `readonly`, `suspended` задача не трогает: пробный период кончается оплатой (§4
 *   `trial → active`), `readonly → suspended` — ручное решение оператора (§7.8 п. 5, `25` §8).
 *
 * «Сегодня» — по поясу тенанта (`tenants.timezone`): `paid_until` — последний оплаченный день
 * включительно (§7.8 п. 2), и в Киеве он не должен кончаться в 02:00 по UTC.
 *
 * Идемпотентность: строка `tenant_limits` берётся `for update`, переход и уведомление пишутся в
 * одной транзакции, и уведомление несёт ключ дедупликации эпизода (`paid_until`) — повторный
 * прогон задачи, два воркера разом или повторная доставка задания не дают второго письма.
 */

/**
 * Длительность grace в днях (`35` §7.8 п. 3, `platform_settings.grace_days`, ориентир 7 дней).
 * Таблицы `platform_settings` в схеме нет — параметры платформы живут константами, как
 * `LIMIT_WARN_PCT` (`35` §7.9, `docs/28` §28.12).
 */
export const GRACE_DAYS = 7

export type SubscriptionStatus = SubscriptionState['status']

export interface GraceTransition {
  from: SubscriptionStatus
  to: SubscriptionStatus
  graceUntil: string | null
}

const DAY = 86_400_000

/** `YYYY-MM-DD` + n дней. */
export function addDays(dateIso: string, days: number): string {
  return new Date(Date.parse(`${dateIso.slice(0, 10)}T00:00:00Z`) + days * DAY).toISOString().slice(0, 10)
}

/**
 * Календарная дата «сейчас» в поясе `tz` — `YYYY-MM-DD`: та же `localDate()`, по которой живут сроки
 * документов человека (`personDocuments.ts`), а не второй способ считать местную полночь.
 * Неизвестный пояс — UTC, а не падение ночной задачи по всем тенантам.
 */
export function todayIn(tz: string, at: Date = new Date()): string {
  try {
    return localDate(at, tz)
  }
  catch {
    return at.toISOString().slice(0, 10)
  }
}

/**
 * Куда должна прийти подписка к дате `today` — чистая функция без базы, по ней работает задача и
 * её проверяют тесты. Возвращает цепочку переходов: тенант, чья задача не шла дольше grace
 * (простой воркера), проходит `active → grace → readonly` за один прогон и получает оба
 * уведомления, а не перепрыгивает льготный период молча.
 */
export function plannedTransitions(
  sub: { status: SubscriptionStatus, paidUntil: string | null, graceUntil: string | null },
  today: string,
  graceDays = GRACE_DAYS,
): GraceTransition[] {
  const out: GraceTransition[] = []
  let status = sub.status
  let graceUntil = sub.graceUntil
  if (status === 'active' && sub.paidUntil && sub.paidUntil < today) {
    // Своя дата оператора (§7.10 «сдвинуть grace_until») — только если она позже конца оплаты:
    // `grace_until` прошлого эпизода остаётся в строке, пока его не сбросит платёж.
    const computed = addDays(sub.paidUntil, graceDays)
    graceUntil = graceUntil && graceUntil > sub.paidUntil ? graceUntil : computed
    out.push({ from: status, to: 'grace', graceUntil })
    status = 'grace'
  }
  if (status === 'grace' && graceUntil && graceUntil < today) {
    out.push({ from: status, to: 'readonly', graceUntil })
  }
  return out
}

async function notify(tx: TenantTx, tenantId: string, t: GraceTransition, paidUntil: string | null): Promise<void> {
  const code = t.to === 'grace' ? 'plan_grace_started' : 'plan_readonly'
  // Ключ — эпизод просрочки (`paid_until`), а не день: письмо о начале grace одно на эпизод,
  // сколько бы раз задача ни прошла; следующий эпизод (после оплаты) — новый ключ.
  const episode = paidUntil ?? 'none'
  for (const r of await billingRecipients(tx)) {
    await enqueueNotification(tx, {
      tenantId,
      userId: r.user_id,
      code,
      payload: { paid_until: paidUntil, grace_until: t.graceUntil },
      dedupKey: `${code}:${tenantId}:${episode}:${r.user_id}`,
    })
  }
}

/**
 * Один проход `billing.grace_scan` по тенанту. `today` — для тестов и ручного прогона; по
 * умолчанию — сегодняшняя дата в поясе тенанта. Возвращает выполненные переходы.
 */
export async function graceScan(tenantId: string, today?: string): Promise<GraceTransition[]> {
  const done = await withTenant(tenantId, null, async (tx) => {
    const [t] = await tx.select({ timezone: tenants.timezone }).from(tenants).where(eq(tenants.id, tenantId))
    const day = today ?? todayIn(t?.timezone ?? 'Europe/Kyiv')
    const [row] = await tx.execute(sql`
      select status, paid_until::text as paid_until, grace_until::text as grace_until
        from tenant_limits where tenant_id = ${tenantId}::uuid for update
    `) as unknown as { status: SubscriptionStatus, paid_until: string | null, grace_until: string | null }[]
    if (!row) return []
    const steps = plannedTransitions({ status: row.status, paidUntil: row.paid_until, graceUntil: row.grace_until }, day)
    if (!steps.length) return []
    const last = steps[steps.length - 1]!
    await tx.update(tenantLimits)
      .set({ status: last.to, graceUntil: last.graceUntil, updatedAt: new Date(), updatedBy: null })
      .where(eq(tenantLimits.tenantId, tenantId))
    for (const s of steps) {
      // Смена статуса подписки меняет, что могут делать все люди тенанта, — событие журнала
      // (Definition of Done: «действия, меняющие чужие данные, пишутся в audit_log»). Актора
      // нет: переход делает задача по сроку, а не человек.
      await recordAudit(tx, {
        tenantId,
        actorId: null,
        action: 'billing.subscription_status',
        entity: 'tenant_limits',
        entityId: tenantId,
        before: { status: s.from, paidUntil: row.paid_until },
        after: { status: s.to, graceUntil: s.graceUntil, reason: s.to === 'grace' ? 'paid_until_passed' : 'grace_until_passed' },
      })
      await notify(tx, tenantId, s, row.paid_until)
    }
    return steps
  })
  if (done.length) {
    invalidateLimits(tenantId)
    // Оператору — та же лента, что у лимитов (`limitNotices.notifyAdmins`): «Прострочені оплати» (§9)
    const { db } = await import('../db/client')
    for (const s of done) {
      await db.insert(platformAudit).values({
        adminId: null, adminEmail: 'system', action: `tenant.subscription_${s.to}`,
        subjectTenantId: tenantId, entity: 'tenant_limits', entityId: tenantId,
        before: { status: s.from }, after: { status: s.to, graceUntil: s.graceUntil },
      })
    }
  }
  return done
}

/**
 * Режим «только чтение» (§7.8 п. 4): что запрещено и что разрешено. Проверяет middleware
 * `03.guards` для каждого изменяющего запроса тенанта, в том числе по Bearer-токену («запись
 * через API»). Список — **разрешённого**, а не запрещённого: новая ручка по умолчанию закрыта,
 * иначе каждая забытая строка запрета тихо открывала бы правку контента без оплаты.
 *
 * Разрешено (§7.8 п. 4, §7.4 «не блокируются никогда», §12 «сертификат выдаётся»): вход и
 * выход, свои настройки и каналы, прохождение **уже назначенного** — уроки, материалы, опросы,
 * тесты, практикумы, время, — ручная проверка ранее сданного, просмотр и выгрузка своих данных,
 * экран тарифа. Самозапись из каталога — новое назначение, а не назначенное: закрыта.
 */
const READONLY_ALLOWED: RegExp[] = [
  /^\/api\/v1\/auth(\/|$)/,
  /^\/api\/v1\/me\/(locale|password|birthday-consent|role\/switch|notifications\/prefs)$/,
  /^\/api\/v1\/settings\/roles\/preview-as$/,
  /^\/api\/v1\/learning\/enrollments\/[^/]+\/lessons\/[^/]+\/(open|tick|download|acknowledge|complete)$/,
  /^\/api\/v1\/learning\/resources\/[^/]+\/(open|tick|download|acknowledge|complete)$/,
  /^\/api\/v1\/learning\/programs\/[^/]+\/open$/,
  /^\/api\/v1\/learning\/quizzes\/[^/]+\/attempts$/,
  /^\/api\/v1\/learning\/surveys\/[^/]+\/(start|answer)$/,
  /^\/api\/v1\/learning\/time\/beats?$/,
  /^\/api\/v1\/learning\/workshops\/[^/]+\/(draft|submit|rate-mentor)$/,
  /^\/api\/v1\/attempts\/[^/]+\/(answers\/[^/]+|submit)$/,
  /^\/api\/v1\/review\/answers\/[^/]+\/grade$/,
  /^\/api\/v1\/review\/submissions\/[^/]+\/(claim|grade|release|comments)$/,
  /^\/api\/v1\/review\/workshops\/[^/]+\/(claim|grade)$/,
  /^\/api\/v1\/notifications\/inbox\/read$/,
  /^\/api\/v1\/notifications\/prefs$/,
  /^\/api\/v1\/push\/(subscribe|unsubscribe)$/,
  /^\/api\/v1\/telegram\/link$/,
  /^\/api\/v1\/exports(\/|$)/,
  /^\/api\/v1\/people\/export$/,
  /^\/api\/v1\/reports\/[^/]+\/export$/,
  /^\/api\/v1\/reports\/builder\/[^/]+\/xlsx$/,
  /^\/api\/v1\/billing(\/|$)/,
]

const SAFE = new Set(['GET', 'HEAD', 'OPTIONS'])

/** Закрыт ли запрос режимом «только чтение»: `GET` остаётся всегда (§7.8 п. 4). */
export function readonlyBlocks(method: string, path: string): boolean {
  if (SAFE.has(method.toUpperCase())) return false
  const clean = path.split('?')[0]!
  return !READONLY_ALLOWED.some(re => re.test(clean))
}

/** Отказ режима «только чтение»: `409`, как у прочих отказов по тарифу (`35` §10), текст — плашки §7.8 п. 4. */
export function readonlyError(locale: 'uk' | 'en' | 'ru' = 'uk') {
  return createError({
    statusCode: 409,
    data: { code: 'tenant.readonly', message: defaultDictionary(locale)['billing.readonlyBlocked'] ?? 'readonly' },
  })
}
