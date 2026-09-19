import { and, eq, lte, sql } from 'drizzle-orm'
import { db } from '../db/client'
import { notificationTemplates, notifications, tenants, users } from '../db/schema'
import { withTenant } from '../utils/withTenant'
import { business } from '../utils/metrics'
import type { TenantTx } from '../utils/withTenant'
import { sendTelegram } from './telegram'

/**
 * Уведомления (docs/03 §3.10, docs/06 §6.4): ни одна задача не шлёт напрямую —
 * только через таблицу notifications: журнал, дедупликация, тихие часы.
 */

/** Шаблоны по умолчанию (uk). Тенант переопределяет через notification_templates. */
export const DEFAULT_TEMPLATES: Record<string, string> = {
  assignment_created: 'Тобі призначили курс «{{course}}».{{#due}} Пройти до {{due}}.{{/due}}',
  enrollment_due_soon: 'Залишилось {{days}} дн.: «{{course}}»',
  enrollment_due_today: 'Сьогодні останній день: «{{course}}»',
  enrollment_overdue: 'Прострочено: «{{course}}»',
  enrollment_overdue_manager: 'Прострочено: {{name}} — «{{course}}»',
  enrollment_extended: 'Термін по «{{course}}» продовжено до {{due}}',
  enrollment_completed_manager: '{{name}} завершив «{{course}}»{{#score}} — {{score}}%{{/score}}',
  attempt_passed: 'Тест «{{quiz}}» зараховано: {{score}}%',
  attempt_failed: 'Тест «{{quiz}}» не зараховано: {{score}}%. {{#left}}Залишилось спроб: {{left}}{{/left}}',
  review_needed: 'Розгорнута відповідь чекає перевірки: {{name}}, «{{quiz}}»',
  review_done: 'Наставник перевірив «{{quiz}}»: {{status}}',
  certificate_issued: 'Сертифікат {{number}} за «{{course}}» видано',
  weekly_digest: 'Тижневий підсумок по точці: завершено {{completed}}, прострочено {{overdue}}, нових {{assigned}}',
  telegram_linked: 'Telegram підключено. Сюди приходитимуть нагадування про навчання.',
  survey_invite: 'Коротке опитування «{{survey}}» — 1 хвилина',
  workshop_assigned: 'Практикум «{{title}}». Здати до {{due}}',
  workshop_submitted: '{{name}} здав «{{title}}». Перевірити',
  workshop_accepted: 'Практикум «{{title}}» зараховано',
  workshop_rework: 'Практикум «{{title}}»: потрібно доопрацювати. {{comment}}',
  workshop_rejected: 'Практикум «{{title}}» не зараховано. {{comment}}',
  workshop_sla_breach: 'Перевірка «{{title}}» висить {{hours}} год',
  workshop_comment: 'Новий коментар до практикуму «{{title}}»',
  news_published: 'Новина: {{title}}',
  plan_on_approval: 'План розвитку чекає погодження',
  plan_approved: 'План розвитку погоджено',
  plan_returned: 'План розвитку повернуто на доопрацювання. {{comment}}',
  goal_status: 'Ціль «{{title}}»: {{status}}. {{comment}}',
  goal_due: 'Ціль «{{title}}» — термін {{due}}',
  goal_due_mentor: 'У підопічного ціль «{{title}}» — термін {{due}}',
  request_new: 'Нова заявка: «{{title}}». Потрібне рішення',
  request_step: 'Заявку «{{title}}» погоджено на цьому етапі',
  request_approved: 'Заявку «{{title}}» схвалено. {{comment}}',
  request_rejected: 'Заявку «{{title}}» відхилено. {{comment}}',
  request_report_required: 'Після навчання «{{title}}» потрібен звіт і сертифікат — додайте їх у заявці',
  request_report_required_manager: 'Підопічний ще не додав звіт про навчання «{{title}}»',
  goal_created: 'Вам поставили ціль «{{title}}»{{#due}} до {{due}}{{/due}}',
  goal_needs_approval: 'Ціль «{{title}}» чекає вашого погодження',
  goal_approved: 'Ціль «{{title}}» погоджено. {{comment}}',
  goal_returned: 'Ціль «{{title}}» повернуто на доопрацювання: {{comment}}',
  plan_period_ending: 'Період плану розвитку завершується {{until}} — час підбити підсумки',
  plan_period_ended: 'Період плану розвитку завершено: цілі без результату закрито як «Не досягнуто». Напишіть підсумок',
  competency_gap_detected: '{{name}}: критичний розрив за компетенціями — {{competencies}}',
  assessment_task_assigned: 'Оцінка «{{title}}»: заповніть анкету до {{due}}',
  assessment_due_soon: 'Оцінка «{{title}}»: анкета ще не заповнена, термін {{due}}',
  assessment_not_submitted: 'Оцінка «{{title}}»: {{name}} не заповнив анкету',
  assessment_cycle_finished: 'Цикл оцінки «{{title}}» завершено: {{subjects}} осіб',
  assessment_results_ready: 'Результати оцінки «{{title}}» готові',
  checklist_due: 'Чек-лист «{{title}}» на точці {{location}}: проведено {{done}} з {{norm}} за тиждень',
  checklist_failed: 'Чек-лист «{{title}}» на точці {{location}} не пройдено: {{score}}%',
  checklist_critical_failed: 'Критичний провал чек-листа «{{title}}» на точці {{location}}',
  action_item_due: 'План дій: «{{text}}» — до {{due}}',
  action_item_overdue: 'Прострочено: «{{text}}» (термін {{due}})',
  meetup_registered: 'Ви записані: «{{title}}», {{starts}}',
  meetup_waitlisted: '«{{title}}»: місць немає, ви в черзі{{#position}} ({{position}}-й){{/position}}',
  meetup_seat_freed: '«{{title}}»: місце звільнилось, ви в списку. {{starts}}',
  meetup_reminder_day: 'Завтра: «{{title}}», {{starts}}{{#room}}, {{room}}{{/room}}',
  meetup_reminder_hour: 'Скоро починається: «{{title}}», {{starts}}',
  meetup_cancelled: 'Заняття «{{title}}» скасовано: {{reason}}{{#alternative}}. Альтернатива: {{alternative}}{{/alternative}}',
  meetup_changed: 'Змінилось заняття «{{title}}»: тепер {{starts}}',
  meetup_missed: 'Ви пропустили заняття «{{title}}»',
  meetup_missed_manager: 'Не прийшли на «{{title}}»: {{names}}',
  meetup_feedback_request: 'Оцініть заняття «{{title}}»',
  webinar_record_ready: 'Запис вебінару «{{title}}» доступний',
  announcement_reminder: 'Оголошення «{{title}}» чекає на підтвердження{{#due}} до {{due}}{{/due}}',
  announcement_overdue_manager: 'Не підтвердили оголошення «{{title}}»: {{names}}',
  scheduled_report: 'Звіт «{{name}}» готовий: {{rows}} рядків. {{url}}',
  program_assigned: 'Вам призначено програму «{{title}}»{{#due}}. Термін: {{due}}{{/due}}',
  program_node_unlocked: '«{{title}}»: відкрився наступний крок{{#step}} — {{step}}{{/step}}',
  program_due_soon: 'Програма «{{title}}»: термін {{due}}',
  program_completed: 'Програму «{{title}}» завершено',
  program_stuck: 'Підопічний не рухається по програмі «{{title}}» 14 днів',
  program_request: 'Заявка на програму «{{title}}» чекає рішення',
  // docs/16 §8
  user_invited: 'Вас запрошено до Lola. Посилання для входу: {{url}}',
  knowledge_review_due: 'Статтю «{{title}}» час перечитати й підтвердити актуальність',
  user_role_granted: '{{#name}}{{name}}: {{/name}}видано роль «{{role}}»',
  user_blocked: 'Доступ для {{name}} заблоковано',
  people_inactive: '{{n}} люд. не заходили понад 30 днів — перевірте, чи не час архівувати',
  import_finished: 'Імпорт «{{file}}» завершено: створено {{created}}, оновлено {{updated}}, помилок {{errors}}. {{url}}',
  import_failed: 'Імпорт «{{file}}» не вдався: {{error}}',
}

/** Мини-шаблонизатор: {{var}} и блоки {{#var}}…{{/var}} при непустом var. */
export function renderTemplate(tpl: string, vars: Record<string, unknown>): string {
  let out = tpl.replace(/\{\{#(\w+)\}\}([\s\S]*?)\{\{\/\1\}\}/g, (_, key: string, inner: string) =>
    vars[key] ? inner : '')
  out = out.replace(/\{\{(\w+)\}\}/g, (_, key: string) => {
    const v = vars[key]
    if (v === null || v === undefined) return ''
    if (typeof v === 'string' && /^\d{4}-\d{2}-\d{2}T/.test(v)) {
      return new Date(v).toLocaleDateString('uk-UA', { day: 'numeric', month: 'long' })
    }
    return String(v)
  })
  return out.trim()
}

/** Тихие часы (docs/03 §3.10): 09:00–20:00 по таймзоне тенанта; вне окна — на утро. */
export function scheduleWithQuietHours(now: Date, timezone: string, quiet: { from: number, to: number } = { from: 9, to: 20 }): Date {
  const local = new Date(now.toLocaleString('en-US', { timeZone: timezone }))
  const hour = local.getHours()
  if (hour >= quiet.from && hour < quiet.to) return now
  const next = new Date(local)
  if (hour >= quiet.to) next.setDate(next.getDate() + 1)
  next.setHours(quiet.from, 0, 0, 0)
  // Разница local↔now даёт смещение таймзоны
  return new Date(now.getTime() + (next.getTime() - local.getTime()))
}

export interface EnqueueInput {
  tenantId: string
  userId: string
  code: string
  payload: Record<string, unknown>
  dedupKey?: string
  channel?: 'telegram' | 'sms' | 'email'
  urgent?: boolean // OTP и подобное — минуя тихие часы
}

/** Кладёт уведомление в очередь; при совпадении dedupKey — молча пропускает. */
export async function enqueueNotification(tx: TenantTx, input: EnqueueInput): Promise<boolean> {
  const [tenant] = await db.select({ timezone: tenants.timezone, settings: tenants.settings }).from(tenants).where(eq(tenants.id, input.tenantId))
  const settings = (tenant?.settings ?? {}) as { quietHours?: { from: number, to: number } }
  const scheduledFor = input.urgent ? new Date() : scheduleWithQuietHours(new Date(), tenant?.timezone ?? 'Europe/Kyiv', settings.quietHours)

  const [row] = await tx.insert(notifications).values({
    tenantId: input.tenantId,
    userId: input.userId,
    code: input.code,
    channel: input.channel ?? 'telegram',
    payload: input.payload,
    dedupKey: input.dedupKey ?? null,
    scheduledFor,
  }).onConflictDoNothing().returning({ id: notifications.id })
  return !!row
}

async function templateFor(tx: TenantTx, tenantId: string, code: string, channel: string, locale: string): Promise<string | null> {
  const [t] = await tx.select().from(notificationTemplates).where(and(
    eq(notificationTemplates.code, code),
    eq(notificationTemplates.channel, channel),
    eq(notificationTemplates.locale, locale),
  ))
  if (t) return t.isEnabled ? t.body : null
  return DEFAULT_TEMPLATES[code] ?? null
}

/**
 * notification.dispatch (docs/06 §6.3): каждую минуту забирает queued с наступившим
 * scheduled_for, рендерит, шлёт. Нет chat_id → skipped (SMS/e-mail — этап 6).
 */
export async function dispatchNotifications(tenantId: string, limit = 100): Promise<{ sent: number, skipped: number, failed: number }> {
  const stats = { sent: 0, skipped: 0, failed: 0 }
  await withTenant(tenantId, null, async (tx) => {
    const due = await tx.select({
      n: notifications,
      user: { telegramChatId: users.telegramChatId, locale: users.locale, fullName: users.fullName },
    })
      .from(notifications)
      .innerJoin(users, eq(users.id, notifications.userId))
      .where(and(eq(notifications.status, 'queued'), lte(notifications.scheduledFor, new Date())))
      .orderBy(notifications.scheduledFor)
      .limit(limit)

    for (const { n, user } of due) {
      const tpl = await templateFor(tx, tenantId, n.code, n.channel, user.locale ?? 'uk')
      if (!tpl) {
        await tx.update(notifications).set({ status: 'skipped', error: 'template disabled', updatedAt: new Date() }).where(eq(notifications.id, n.id))
        stats.skipped++
        continue
      }
      const text = renderTemplate(tpl, { ...(n.payload as Record<string, unknown>), name: user.fullName })

      if (n.channel === 'telegram') {
        if (!user.telegramChatId) {
          await tx.update(notifications).set({ status: 'skipped', renderedText: text, error: 'no telegram', updatedAt: new Date() }).where(eq(notifications.id, n.id))
          stats.skipped++
          continue
        }
        const payload = n.payload as { enrollmentId?: string }
        const res = await sendTelegram(user.telegramChatId, text, payload.enrollmentId ? { enrollmentId: payload.enrollmentId } : undefined)
        if (res.ok) {
          await tx.update(notifications).set({ status: 'sent', renderedText: text, sentAt: new Date(), updatedAt: new Date() }).where(eq(notifications.id, n.id))
          stats.sent++
          business.inc({ event: 'notification_sent' })
        }
        else if (res.blocked) {
          // Бот заблокирован (docs/06 §6.4): помечаем, канал далее — SMS
          await tx.update(users).set({ telegramChatId: null }).where(eq(users.id, n.userId))
          await tx.update(notifications).set({ status: 'skipped', renderedText: text, error: 'telegram_blocked', updatedAt: new Date() }).where(eq(notifications.id, n.id))
          stats.skipped++
        }
        else {
          await tx.update(notifications).set({ status: 'failed', renderedText: text, error: res.error, updatedAt: new Date() }).where(eq(notifications.id, n.id))
          stats.failed++
          business.inc({ event: 'notification_failed' })
          business.inc({ event: 'telegram_error' })
        }
      }
      else {
        const { sendViaChannel } = await import('./channels')
        const res = await sendViaChannel(tenantId, n.channel as 'sms' | 'email', { userId: n.userId, text, subject: n.code })
        if (res.ok) {
          await tx.update(notifications).set({ status: 'sent', renderedText: text, sentAt: new Date(), updatedAt: new Date() }).where(eq(notifications.id, n.id))
          stats.sent++
        }
        else if (res.skipped) {
          await tx.update(notifications).set({ status: 'skipped', renderedText: text, error: res.error, updatedAt: new Date() }).where(eq(notifications.id, n.id))
          stats.skipped++
        }
        else {
          await tx.update(notifications).set({ status: 'failed', renderedText: text, error: res.error, updatedAt: new Date() }).where(eq(notifications.id, n.id))
          stats.failed++
        }
      }
    }
  })
  return stats
}

export async function listNotifications(ctx: { tenantId: string, actorId: string }, filter: { userId?: string, status?: string } = {}) {
  return withTenant(ctx.tenantId, ctx.actorId, async (tx) => {
    return tx.select({
      id: notifications.id,
      userId: notifications.userId,
      fullName: users.fullName,
      code: notifications.code,
      channel: notifications.channel,
      status: notifications.status,
      renderedText: notifications.renderedText,
      error: notifications.error,
      scheduledFor: notifications.scheduledFor,
      sentAt: notifications.sentAt,
      createdAt: notifications.createdAt,
    })
      .from(notifications)
      .innerJoin(users, eq(users.id, notifications.userId))
      .where(and(
        ...(filter.userId ? [eq(notifications.userId, filter.userId)] : []),
        ...(filter.status ? [eq(notifications.status, filter.status)] : []),
      ))
      .orderBy(sql`${notifications.createdAt} desc`)
      .limit(200)
  })
}

export async function tenantsWithQueued(): Promise<string[]> {
  const rows = await db.execute(sql`select distinct tenant_id from notifications where status = 'queued' and scheduled_for <= now()`)
  return (rows as unknown as { tenant_id: string }[]).map(r => r.tenant_id)
}
