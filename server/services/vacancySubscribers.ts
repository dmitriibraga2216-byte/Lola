import { and, eq } from 'drizzle-orm'
import { vacancies, vacancySubscribers } from '../db/schema'
import { withTenant } from '../utils/withTenant'
import { resolveLocale } from '../../shared/domain/dateFormat'
import { VACANCY_SUBSCRIBE_PER_HOUR } from '../../shared/enums'
import { sendEmail } from './channels'
import { recordAudit } from './audit'
import { hitRateLimit } from './rateLimit'
import { readSettings } from './settings'
import { tenantOverrides } from './translations'
import { alignDelay, ipHash, lookupVacancyLink, pageLanguage } from './publicApply'
import type { PublicCtx } from './publicApply'

/**
 * Подписка «Повідомити, коли відкриється» (`docs/v2/29-vacancies.md` §5.6, §10
 * `POST /j/:token/subscribe`, §11 `vacancy.subscriber_notify`; решение `v2/44` Р-VT.2).
 *
 * Страница приостановленной вакансии отвечает 410 и предлагает оставить почту. Адрес живёт
 * ровно до одного письма `vacancy_subscriber_reopened`: подписка одноразовая, и хранить почту
 * постороннего человека дольше, чем нужно для обещанного письма, незачем. Закрытие вакансии
 * удаляет подписки без письма (`vacancies.ts#closeVacancy()`).
 *
 * Правило публичного контура (`docs/27` §27.8.1) здесь то же, что у формы отклика: тенант из
 * токена, работа внутри `withTenant()`, `hitRateLimit`, неизвестный и закрытый токен — `404`
 * с выровненным временем. И тот же принцип одинакового ответа (§7.3): у опубликованной
 * вакансии подписка не хранится (ждать нечего), но ответ — тот же `202`.
 */

export type SubscribeResult = { ok: true } | { ok: false, code: 'not_found' | 'rate_limited' }

export async function subscribeToVacancy(token: string, email: string, ctx: PublicCtx): Promise<SubscribeResult> {
  const link = await lookupVacancyLink(token)
  if (!link || !link.public_enabled) {
    await alignDelay()
    return { ok: false, code: 'not_found' }
  }
  const ipH = ipHash(link.tenant_id, ctx.ip)
  if (!await hitRateLimit(`apply:subscribe:${link.tenant_id}:${ipH}`, VACANCY_SUBSCRIBE_PER_HOUR, 3600)) {
    return { ok: false, code: 'rate_limited' }
  }
  if (link.state !== 'paused') return { ok: true }

  await withTenant(link.tenant_id, link.owner_id, async (tx) => {
    const [row] = await tx.select({ lang: vacancies.publicLanguage }).from(vacancies).where(eq(vacancies.id, link.id))
    await tx.insert(vacancySubscribers).values({
      tenantId: link.tenant_id,
      vacancyId: link.id,
      email: email.trim(),
      locale: await pageLanguage(tx, link.tenant_id, row?.lang ?? null),
    }).onConflictDoNothing()
  })
  return { ok: true }
}

export interface NotifyResult { sent: number, failed: number, skipped: number }

/**
 * `vacancy.subscriber_notify` — по событию возобновления набора (`paused → published`).
 *
 * Письмо — шаблон `vacancy_subscriber_reopened` (PR-37) плюс ссылка на страницу; подписка
 * удаляется после отправки, поэтому повтор задачи не шлёт второго письма. SMTP не настроен
 * или шаблон выключен (`skipped`) — подписка остаётся до следующего возобновления: человек
 * не виноват, что письмо некому отправить. Сбой отправки — исключение наверх, очередь
 * повторит только неотправленным. Вакансия снова на паузе к моменту задачи — не шлём ничего.
 */
export async function notifyVacancySubscribers(tenantId: string, vacancyId: string): Promise<NotifyResult> {
  const ctx = await withTenant(tenantId, null, async (tx) => {
    const [vac] = await tx.select({ title: vacancies.title, state: vacancies.state, token: vacancies.publicToken })
      .from(vacancies).where(eq(vacancies.id, vacancyId))
    if (!vac || vac.state !== 'published' || !vac.token) return null
    const subs = await tx.select().from(vacancySubscribers).where(eq(vacancySubscribers.vacancyId, vacancyId))
    return { vac, subs }
  })
  const result: NotifyResult = { sent: 0, failed: 0, skipped: 0 }
  if (!ctx || !ctx.subs.length) return result

  const base = (process.env.APP_URL ?? 'http://localhost:3000').replace(/\/$/, '')
  const link = `${base}/j/${ctx.vac.token}`
  for (const sub of ctx.subs) {
    const r = await sendReopenedEmail(tenantId, sub.email, sub.locale ?? 'uk', { vacancy: ctx.vac.title, link })
    if (r === 'sent') {
      await withTenant(tenantId, null, tx => tx.delete(vacancySubscribers)
        .where(and(eq(vacancySubscribers.id, sub.id), eq(vacancySubscribers.vacancyId, vacancyId))))
      result.sent++
    }
    else if (r === 'skipped') result.skipped++
    else result.failed++
  }
  await withTenant(tenantId, null, tx => recordAudit(tx, {
    tenantId, actorId: null, action: 'vacancy.subscribers_notified', entity: 'vacancy', entityId: vacancyId,
    after: { ...result },
  }))
  return result
}

/** Письмо по шаблону тенанта (или глобальному), как `otpChannel.ts#sendOtpEmail()`. */
async function sendReopenedEmail(tenantId: string, to: string, locale: string, vars: { vacancy: string, link: string }): Promise<'sent' | 'skipped' | 'failed'> {
  const prepared = await withTenant(tenantId, null, async (tx) => {
    const { templateFor, renderTemplate } = await import('./notifications')
    const { buildEmailHtml } = await import('./emailRender')
    const loc = resolveLocale(locale)
    const tpl = await templateFor(tx, tenantId, 'vacancy_subscriber_reopened', 'email', loc)
    if (!tpl) return null
    const settings = await readSettings(tx, tenantId)
    const trMap = await tenantOverrides(tenantId, loc)
    const tr = (phrase: string) => trMap[phrase] ?? phrase
    const headline = renderTemplate(tpl.body, vars, tr, loc)
    // Ссылка — отдельной строкой после текста шаблона: текст правит тенант, а без ссылки
    // письмо «набір знову відкрито» бесполезно.
    const text = `${headline}\n\n${vars.link}`
    const subject = renderTemplate(tpl.subject ?? tpl.body, vars, tr, loc)
    const html = buildEmailHtml({
      bodyMjml: `<mj-text>${escapeHtml(headline)}</mj-text><mj-text><a href="${escapeHtml(vars.link)}">${escapeHtml(vars.link)}</a></mj-text>`,
      fallbackText: text,
      layout: { headerMjml: settings.emailLayout.headerMjml, footerMjml: settings.emailLayout.footerMjml },
    })
    return { subject, text, html }
  })
  if (!prepared) return 'skipped'
  const r = await sendEmail(tenantId, to, prepared.subject, prepared.text, prepared.html)
  if (r.ok) return 'sent'
  return r.skipped ? 'skipped' : 'failed'
}

function escapeHtml(s: string): string {
  return s.replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;').replace(/"/g, '&quot;')
}
