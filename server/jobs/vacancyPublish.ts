import { eq, inArray, sql } from 'drizzle-orm'
import { jobBoardAccounts, vacancies } from '../db/schema'
import { withTenant } from '../utils/withTenant'
import { checkAccountHealth, publicationExpiryScan, removeExternalPublications } from '../services/vacancyPublications'
import { notifyVacancySubscribers } from '../services/vacancySubscribers'
import { vacancyStatsRollupTenant } from '../services/vacancyStats'
import { enqueueNotification, tenantAdminIds } from '../services/notifications'
import { VACANCY_SPAM_BURST_HARDEN_HOURS, VACANCY_SPAM_BURST_THRESHOLD_PER_HOUR } from '../../shared/enums'

/**
 * Фоновые задачи публикации (`docs/v2/29-vacancies.md` §11, §7.8, §7.15, план `45` PR-17).
 * Обе раскладываются по тенантам круго `runPerTenant`, как остальные сканы пакета.
 */

/**
 * `vacancy.publication_health` — каждые 30 мин (§11, критерий §13 к. 12). Проверяет
 * `health()` заглушки у всех подключённых аккаунтов; отзыв кладёт каскад в
 * `jobBoardAccounts.ts#revokeAccount()` — эта функция только находит, кого спрашивать.
 */
export async function vacancyPublicationHealthTenant(tenantId: string): Promise<number> {
  // `failing` — тем же проходом: иначе замолчавший аккаунт не вернулся бы в `active` сам.
  const accounts = await withTenant(tenantId, null, tx => tx.select({ id: jobBoardAccounts.id })
    .from(jobBoardAccounts).where(inArray(jobBoardAccounts.status, ['active', 'failing'])))
  for (const a of accounts) await checkAccountHealth(tenantId, a.id)
  return accounts.length
}

/**
 * `vacancy.spam_watch` — каждые 10 мин (§11, §7.8). Больше `VACANCY_SPAM_BURST_THRESHOLD_PER_HOUR`
 * блокировок по вакансии за час → лимиты §7.4 удвоены на `VACANCY_SPAM_BURST_HARDEN_HOURS`,
 * уходит `vacancy_spam_burst`. Пока хардненинг уже активен — новый не назначается и второе
 * уведомление не уходит: это и есть дедупликация, без отдельного ключа.
 */
export async function vacancySpamWatchTenant(tenantId: string): Promise<number> {
  return withTenant(tenantId, null, async (tx) => {
    const bursts = await tx.execute(sql`
      select vacancy_id, count(*)::int as n from public_apply_attempts
       where outcome = 'submit_blocked' and vacancy_id is not null and created_at > now() - interval '1 hour'
       group by vacancy_id having count(*) >= ${VACANCY_SPAM_BURST_THRESHOLD_PER_HOUR}
    `) as unknown as { vacancy_id: string, n: number }[]

    let hardened = 0
    for (const b of bursts) {
      const [vac] = await tx.select({ id: vacancies.id, title: vacancies.title, recruiterId: vacancies.recruiterId, spamHardenedUntil: vacancies.spamHardenedUntil })
        .from(vacancies).where(eq(vacancies.id, b.vacancy_id))
      if (!vac) continue
      if (vac.spamHardenedUntil && vac.spamHardenedUntil.getTime() > Date.now()) continue

      const until = new Date(Date.now() + VACANCY_SPAM_BURST_HARDEN_HOURS * 3600_000)
      await tx.update(vacancies).set({ spamHardenedUntil: until, updatedAt: new Date() }).where(eq(vacancies.id, b.vacancy_id))

      const recipients = new Set<string>(await tenantAdminIds(tx, tenantId))
      if (vac.recruiterId) recipients.add(vac.recruiterId)
      const day = new Date().toISOString().slice(0, 10)
      for (const userId of recipients) {
        await enqueueNotification(tx, {
          tenantId, userId, code: 'vacancy_spam_burst', payload: { vacancy: vac.title },
          // dedupKey несёт userId — иначе второй получатель в цикле молча теряет уведомление.
          dedupKey: `vacancy_spam_burst:${b.vacancy_id}:${day}:${userId}`,
        }).catch(() => false)
      }
      hardened++
    }
    return hardened
  })
}

/**
 * `vacancy.remove_external` — по событию закрытия (§11, §4 «публикации в очередь на снятие»).
 * Пока хоть одна площадка не ответила, задача падает: повтор с экспонентой делает очередь
 * (`queue.ts`), уже снятые строки второй раз не трогаются.
 */
export async function vacancyRemoveExternalJob(tenantId: string, vacancyId: string): Promise<{ removed: number, pending: number }> {
  const r = await removeExternalPublications(tenantId, vacancyId)
  if (r.pending) throw new Error(`[vacancy.remove_external] ${vacancyId}: площадка не ответила на ${r.pending} публикаций`)
  return r
}

/** `vacancy.publication_expiry` — ежедневно 08:00 (§11): `expired` и предупреждение за 3 дня. */
export async function vacancyPublicationExpiryTenant(tenantId: string): Promise<{ expired: number, warned: number }> {
  return publicationExpiryScan(tenantId)
}

/** `vacancy.subscriber_notify` — по событию возобновления набора (§11, §5.6). */
export async function vacancySubscriberNotifyJob(tenantId: string, vacancyId: string) {
  const r = await notifyVacancySubscribers(tenantId, vacancyId)
  if (r.failed) throw new Error(`[vacancy.subscriber_notify] ${vacancyId}: не надіслано ${r.failed} листів`)
  return r
}

/** `vacancy.stats_rollup` — ежечасно (§11): свёртка публичной страницы для §9.1 и §9.4. */
export async function vacancyStatsRollupJob(tenantId: string): Promise<number> {
  return vacancyStatsRollupTenant(tenantId)
}

