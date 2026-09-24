import { and, desc, eq, inArray } from 'drizzle-orm'
import { jobBoardAccounts, vacancies, vacancyLanguages, vacancyPublications } from '../db/schema'
import { withTenant } from '../utils/withTenant'
import { recordAudit } from './audit'
import { accountSecret, revokeAccount } from './jobBoardAccounts'
import { adapterFor, payloadHash } from './jobBoardAdapter'
import type { JobBoardPublishPayload } from './jobBoardAdapter'
import { rowById } from './vacancies'
import type { Viewer } from './vacancies'
import { enqueueNotification, tenantAdminIds } from './notifications'
import { enqueuePublishRetry } from './queue'
import { VACANCY_PUBLISH_RETRY_DELAYS_SEC } from '../../shared/enums'
import type { JobBoardProvider } from '../../shared/enums'
import type { VacancyPublicationCreateInput, VacancyPublicationLinkExternalInput } from '../../shared/schemas/vacancies'

/**
 * Площадки и журнал публикаций (`docs/v2/29-vacancies.md` §3.8, §7.13–§7.17, план `45` PR-17).
 *
 * Два пути создания строки:
 * 1. **Через адаптер** (`accountIds`) — `queued`, затем синхронная попытка `publish()`
 *    заглушки в этом же запросе (сеть не нужна — заглушка детерминирована и быстра); на
 *    временной ошибке строка остаётся `queued` и уходит на повтор через 1/5/25 мин
 *    (`VACANCY_PUBLISH_RETRY_DELAYS_SEC`, задача `vacancy.publish_external`).
 * 2. **Вручную** (`manual`, `44` §8) — рекрутер уже опублікував об'яву сам, строка сразу
 *    `manual` с готовой ссылкой, ни адаптер, ни фоновые задачи её не касаются.
 *
 * `attemptPublish()`/`checkAccountHealth()` — отдельные транзакции, вызванные последовательно
 * из `createPublications()`/фоновой задачи, а не вложенные `withTenant()` (см. `media.ts`
 * `createUploadUrl()` → `recordUsage()` — тот же приём в этом кодовой базе).
 */

export interface PublicationRow {
  id: string
  vacancyId: string
  accountId: string
  provider: string
  ownerType: string
  state: string
  externalId: string | null
  externalUrl: string | null
  publishedAt: Date | null
  expiresAt: Date | null
  attempts: number
  lastErrorCode: string | null
  lastError: string | null
  createdAt: Date
}

const ROW = {
  id: vacancyPublications.id,
  vacancyId: vacancyPublications.vacancyId,
  accountId: vacancyPublications.accountId,
  provider: jobBoardAccounts.provider,
  ownerType: jobBoardAccounts.ownerType,
  state: vacancyPublications.state,
  externalId: vacancyPublications.externalId,
  externalUrl: vacancyPublications.externalUrl,
  publishedAt: vacancyPublications.publishedAt,
  expiresAt: vacancyPublications.expiresAt,
  attempts: vacancyPublications.attempts,
  lastErrorCode: vacancyPublications.lastErrorCode,
  lastError: vacancyPublications.lastError,
  createdAt: vacancyPublications.createdAt,
}

function buildPayload(row: { title: string, descriptionHtml: string | null, requirementsHtml: string | null, dutiesHtml: string | null, extraHtml: string | null, city: string | null, countryCode: string | null, employmentType: string | null, workFormat: string | null, experienceLevel: string | null, educationLevel: string | null, salaryFrom: string | null, salaryTo: string | null, salaryCurrency: string, salaryVisible: boolean, publicToken: string | null }, languages: { langCode: string, level: string, isRequired: boolean }[]): JobBoardPublishPayload {
  const base = (process.env.APP_URL ?? 'http://localhost:3000').replace(/\/$/, '')
  return {
    title: row.title,
    descriptionHtml: row.descriptionHtml,
    requirementsHtml: row.requirementsHtml,
    dutiesHtml: row.dutiesHtml,
    extraHtml: row.extraHtml,
    city: row.city,
    countryCode: row.countryCode,
    employmentType: row.employmentType,
    workFormat: row.workFormat,
    experienceLevel: row.experienceLevel,
    educationLevel: row.educationLevel,
    // §7.18: вилка уходит наружу только при salaryVisible — адаптер сам решает, показывать её.
    salaryFrom: row.salaryVisible ? row.salaryFrom : null,
    salaryTo: row.salaryVisible ? row.salaryTo : null,
    salaryCurrency: row.salaryCurrency,
    salaryVisible: row.salaryVisible,
    languages,
    applyUrl: row.publicToken ? `${base}/j/${row.publicToken}` : base,
  }
}

export async function listPublications(v: Viewer, vacancyId: string): Promise<PublicationRow[] | null> {
  return withTenant(v.tenantId, v.actorId, async (tx) => {
    if (!await rowById(tx, v, vacancyId)) return null
    return await tx.select(ROW).from(vacancyPublications)
      .innerJoin(jobBoardAccounts, eq(jobBoardAccounts.id, vacancyPublications.accountId))
      .where(eq(vacancyPublications.vacancyId, vacancyId))
      .orderBy(desc(vacancyPublications.createdAt)) as unknown as PublicationRow[]
  })
}

export type CreatePublicationsResult
  = | { ok: true, publications: PublicationRow[] }
    | { ok: false, code: 'not_found' }
    | { ok: false, code: 'account_not_found' | 'account_not_active' | 'account_forbidden', accountId: string }
    | { ok: false, code: 'duplicate', accountId: string }

/** Аккаунт виден пользователю для публикации: свой личный/рекрутерский или любой компанейский (§7.14, как `jobBoardAccounts.listAccounts`). */
function accountVisible(ctx: { actorId: string, isAdmin: boolean }, account: { ownerType: string, ownerUserId: string | null }): boolean {
  return ctx.isAdmin || account.ownerType === 'company' || account.ownerUserId === ctx.actorId
}

export async function createPublications(
  v: Viewer, ctx: { isAdmin: boolean }, vacancyId: string, input: VacancyPublicationCreateInput,
): Promise<CreatePublicationsResult> {
  const created = await withTenant(v.tenantId, v.actorId, async (tx) => {
    const vac = await rowById(tx, v, vacancyId)
    if (!vac) return { ok: false, code: 'not_found' } as CreatePublicationsResult

    const rows: { id: string, accountId: string }[] = []

    if (input.manual) {
      const [account] = await tx.select().from(jobBoardAccounts).where(eq(jobBoardAccounts.id, input.manual.accountId))
      if (!account) return { ok: false, code: 'account_not_found', accountId: input.manual.accountId } as CreatePublicationsResult
      if (!accountVisible({ actorId: v.actorId, isAdmin: ctx.isAdmin }, account)) return { ok: false, code: 'account_forbidden', accountId: account.id } as CreatePublicationsResult
      const dup = await tx.select({ id: vacancyPublications.id }).from(vacancyPublications)
        .where(and(eq(vacancyPublications.vacancyId, vacancyId), eq(vacancyPublications.accountId, account.id), inArray(vacancyPublications.state, ['queued', 'publishing', 'active', 'conflict', 'manual'])))
      if (dup.length) return { ok: false, code: 'duplicate', accountId: account.id } as CreatePublicationsResult
      const [row] = await tx.insert(vacancyPublications).values({
        tenantId: v.tenantId, vacancyId, accountId: account.id, state: 'manual',
        externalUrl: input.manual.externalUrl, publishedAt: new Date(), requestedBy: v.actorId,
      }).returning({ id: vacancyPublications.id })
      await recordAudit(tx, {
        tenantId: v.tenantId, actorId: v.actorId, action: 'vacancy.published_external', entity: 'vacancy_publication', entityId: row!.id,
        after: { vacancyId, accountId: account.id, provider: account.provider, manual: true },
      })
      rows.push({ id: row!.id, accountId: account.id })
    }

    for (const accountId of input.accountIds ?? []) {
      const [account] = await tx.select().from(jobBoardAccounts).where(eq(jobBoardAccounts.id, accountId))
      if (!account) return { ok: false, code: 'account_not_found', accountId } as CreatePublicationsResult
      if (!accountVisible({ actorId: v.actorId, isAdmin: ctx.isAdmin }, account)) return { ok: false, code: 'account_forbidden', accountId } as CreatePublicationsResult
      if (account.status !== 'active') return { ok: false, code: 'account_not_active', accountId } as CreatePublicationsResult
      const dup = await tx.select({ id: vacancyPublications.id }).from(vacancyPublications)
        .where(and(eq(vacancyPublications.vacancyId, vacancyId), eq(vacancyPublications.accountId, accountId), inArray(vacancyPublications.state, ['queued', 'publishing', 'active', 'conflict', 'manual'])))
      if (dup.length) return { ok: false, code: 'duplicate', accountId } as CreatePublicationsResult
      const [row] = await tx.insert(vacancyPublications).values({
        tenantId: v.tenantId, vacancyId, accountId, state: 'queued', requestedBy: v.actorId,
      }).returning({ id: vacancyPublications.id })
      rows.push({ id: row!.id, accountId })
    }

    return { ok: true, ids: rows.map(r => r.id) } as { ok: true, ids: string[] }
  })

  if (!('ok' in created) || !created.ok) return created as CreatePublicationsResult

  // Синхронная попытка публикации для строк через адаптер (`manual` уже терминальна выше).
  for (const id of (created as { ok: true, ids: string[] }).ids) await attemptPublish(v.tenantId, id)

  const publications = await listPublications(v, vacancyId)
  return { ok: true, publications: publications ?? [] }
}

/**
 * Первая (или повторная, из фоновой задачи) попытка публикации строки `queued` (§7.13, §7.16).
 * Временная ошибка — счётчик `attempts` растёт, строка остаётся `queued`; постоянная — `failed`
 * и уведомление; отзыв токена — каскад через `revokeAccount()`.
 */
export async function attemptPublish(tenantId: string, publicationId: string): Promise<void> {
  const ctx = await withTenant(tenantId, null, async (tx) => {
    const [pub] = await tx.select().from(vacancyPublications).where(eq(vacancyPublications.id, publicationId))
    if (!pub || pub.state !== 'queued') return null
    const [account] = await tx.select().from(jobBoardAccounts).where(eq(jobBoardAccounts.id, pub.accountId))
    if (!account) return null
    const [vac] = await tx.select().from(vacancies).where(eq(vacancies.id, pub.vacancyId))
    if (!vac) return null
    const languages = await tx.select({ langCode: vacancyLanguages.langCode, level: vacancyLanguages.level, isRequired: vacancyLanguages.isRequired })
      .from(vacancyLanguages).where(eq(vacancyLanguages.vacancyId, pub.vacancyId))
    const secret = await accountSecret(tx, pub.accountId)
    return { pub, account, vac, languages, secret }
  })
  if (!ctx) return
  const { pub, account, vac, languages, secret } = ctx

  if (!secret || account.status !== 'active') {
    await withTenant(tenantId, null, tx => tx.update(vacancyPublications)
      .set({ state: 'conflict', lastErrorCode: 'jobboard.account_not_active', updatedAt: new Date() })
      .where(eq(vacancyPublications.id, publicationId)))
    return
  }

  const payload = buildPayload(vac, languages)
  const result = await adapterFor(account.provider as JobBoardProvider).publish(secret, payload)

  if (result.ok) {
    await withTenant(tenantId, null, async (tx) => {
      await tx.update(vacancyPublications).set({
        state: 'active', externalId: result.externalId, externalUrl: result.externalUrl,
        expiresAt: result.expiresAt, payloadHash: payloadHash(payload), publishedAt: new Date(), updatedAt: new Date(),
      }).where(eq(vacancyPublications.id, publicationId))
      await recordAudit(tx, {
        tenantId, actorId: pub.requestedBy, action: 'vacancy.published_external', entity: 'vacancy_publication', entityId: publicationId,
        after: { vacancyId: pub.vacancyId, accountId: pub.accountId, provider: account.provider, payloadHash: payloadHash(payload) },
      })
      await enqueueNotification(tx, {
        tenantId, userId: pub.requestedBy, code: 'vacancy_published_external',
        // Ключ `platform` — шаблон уже завела PR-37 (`notifications.ts` DEFAULT_TEMPLATES).
        payload: { vacancy: vac.title, platform: account.provider },
        dedupKey: `vacancy_published_external:${publicationId}`,
      }).catch(() => false)
    })
    return
  }

  if (result.revoked) {
    await revokeAccount(tenantId, pub.accountId)
    return
  }

  if (result.retryable && pub.attempts < VACANCY_PUBLISH_RETRY_DELAYS_SEC.length) {
    await withTenant(tenantId, null, tx => tx.update(vacancyPublications)
      .set({ attempts: pub.attempts + 1, lastErrorCode: result.error, updatedAt: new Date() })
      .where(eq(vacancyPublications.id, publicationId)))
    await enqueuePublishRetry(tenantId, publicationId, VACANCY_PUBLISH_RETRY_DELAYS_SEC[pub.attempts]!)
    return
  }

  // Постоянная ошибка или ретраи исчерпаны (§7.16): `failed`, уведомление инициатору и HR/админу.
  await withTenant(tenantId, null, async (tx) => {
    await tx.update(vacancyPublications).set({ state: 'failed', lastErrorCode: result.error, updatedAt: new Date() }).where(eq(vacancyPublications.id, publicationId))
    const day = new Date().toISOString().slice(0, 10)
    const recipients = new Set<string>([pub.requestedBy, ...await tenantAdminIds(tx, tenantId)])
    for (const userId of recipients) {
      await enqueueNotification(tx, {
        tenantId, userId, code: 'vacancy_publication_failed',
        payload: { vacancy: vac.title, platform: account.provider, error: result.error },
        // dedupKey несёт userId — цикл на несколько адресатов, ключ обязан быть per-user
        // (иначе второй получатель молча теряет уведомление, найдено при тестировании PR-17).
        dedupKey: `vacancy_publication_failed:${publicationId}:${day}:${userId}`,
      }).catch(() => false)
    }
  })
}

/**
 * Ревалидация здоровья активных публикаций через адаптер (`29` §11 `vacancy.publication_health`,
 * критерий §13 к. 12). `manual`-строки не проверяются: у них нет секрета и нечего спрашивать.
 */
export async function checkAccountHealth(tenantId: string, accountId: string): Promise<void> {
  const account = await withTenant(tenantId, null, async (tx) => {
    const [a] = await tx.select().from(jobBoardAccounts).where(eq(jobBoardAccounts.id, accountId))
    return a && a.status === 'active' ? a : null
  })
  if (!account) return
  const secret = await withTenant(tenantId, null, tx => accountSecret(tx, accountId))
  if (!secret) return
  const health = await adapterFor(account.provider as JobBoardProvider).health(secret)
  if (!health.ok && health.revoked) await revokeAccount(tenantId, accountId)
}

export type RemoveResult = { ok: true } | { ok: false, code: 'not_found' | 'not_active' }

/** Снятие публикации (`29` §7.13): помечается `removed`, адаптер не вызывается — за рамками PR-17 (см. `docs/v2/46-progress.md`). */
export async function removePublication(v: Viewer, vacancyId: string, pubId: string): Promise<RemoveResult> {
  return withTenant(v.tenantId, v.actorId, async (tx) => {
    if (!await rowById(tx, v, vacancyId)) return { ok: false, code: 'not_found' }
    const [row] = await tx.select().from(vacancyPublications).where(and(eq(vacancyPublications.id, pubId), eq(vacancyPublications.vacancyId, vacancyId)))
    if (!row) return { ok: false, code: 'not_found' }
    if (!['queued', 'active', 'manual', 'conflict', 'failed'].includes(row.state)) return { ok: false, code: 'not_active' }
    await tx.update(vacancyPublications).set({ state: 'removed', removedAt: new Date(), updatedAt: new Date() }).where(eq(vacancyPublications.id, pubId))
    await recordAudit(tx, { tenantId: v.tenantId, actorId: v.actorId, action: 'vacancy.unpublished_external', entity: 'vacancy_publication', entityId: pubId, before: { state: row.state } })
    return { ok: true }
  })
}

export type LinkExternalResult = { ok: true } | { ok: false, code: 'not_found' | 'not_conflict' }

/** «Прив'язати існуюче оголошення» при `conflict` (§7.17, §7.8 крайний случай 8). */
export async function linkExternal(v: Viewer, vacancyId: string, pubId: string, input: VacancyPublicationLinkExternalInput): Promise<LinkExternalResult> {
  return withTenant(v.tenantId, v.actorId, async (tx) => {
    if (!await rowById(tx, v, vacancyId)) return { ok: false, code: 'not_found' }
    const [row] = await tx.select().from(vacancyPublications).where(and(eq(vacancyPublications.id, pubId), eq(vacancyPublications.vacancyId, vacancyId)))
    if (!row) return { ok: false, code: 'not_found' }
    if (row.state !== 'conflict') return { ok: false, code: 'not_conflict' }
    await tx.update(vacancyPublications).set({ state: 'active', externalId: input.externalId, updatedAt: new Date() }).where(eq(vacancyPublications.id, pubId))
    await recordAudit(tx, { tenantId: v.tenantId, actorId: v.actorId, action: 'vacancy.publication_linked', entity: 'vacancy_publication', entityId: pubId, after: { externalId: input.externalId } })
    return { ok: true }
  })
}
