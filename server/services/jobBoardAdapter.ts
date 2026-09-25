import { createHash, randomUUID } from 'node:crypto'
import { JOB_BOARD_PROVIDERS } from '../../shared/enums'
import type { JobBoardProvider } from '../../shared/enums'

/**
 * Абстракция площадки публикации (`docs/v2/29-vacancies.md` §7.18, план `45` PR-17).
 *
 * **Реальные аккаунты площадок не заводятся** (`docs/v2/HANDOFF.md` §6: секреты и внешние
 * сервисы — абстракцию писать можно, реальные ключи заводить нет). Адаптер реализует ровно
 * то, что §7.18 называет: приём нормализованного payload, `publish`/`update`/`remove`,
 * `health`. Он детерминированный и не делает ни одного сетевого вызова — тем самым работает
 * в тестах и в CI без единого ключа, ровно как просит задание.
 *
 * `getAuthUrl`/`handleCallback` из §7.18 и §10 здесь не реализованы: без настоящего вендора
 * это был бы редирект в никуда (`[решение]`, зафиксировано в `docs/v2/46-progress.md`,
 * запись PR-17). `connect()` замещает пару шагов одним синхронным вызовом — контракт
 * подключения (кто может подключить, что сохраняется) остаётся тем же, а когда придёт
 * настоящий вендор (не в этом пакете), под тот же интерфейс `JobBoardAdapter` встанет
 * реализация с настоящим HTTP и настоящим OAuth без переписывания вызывающего кода.
 */

export interface JobBoardPublishPayload {
  title: string
  descriptionHtml: string | null
  requirementsHtml: string | null
  dutiesHtml: string | null
  extraHtml: string | null
  city: string | null
  countryCode: string | null
  employmentType: string | null
  workFormat: string | null
  experienceLevel: string | null
  educationLevel: string | null
  salaryFrom: string | null
  salaryTo: string | null
  salaryCurrency: string
  salaryVisible: boolean
  languages: { langCode: string, level: string, isRequired: boolean }[]
  /** Публичная ссылка отклика (`29` §7.18) — единственное, что площадка получает как «куда вести». */
  applyUrl: string
}

/** Хэш нормализованного payload — для `vacancy_publications.payload_hash` и `audit_log` (§7.13, критерий §13 к. 15). */
export function payloadHash(payload: JobBoardPublishPayload): string {
  return createHash('sha256').update(JSON.stringify(payload)).digest('hex')
}

export type JobBoardPublishResult
  = | { ok: true, externalId: string, externalUrl: string, expiresAt: Date | null }
    /** `retryable` — временная ошибка (§7.16: ретраи 1/5/25 мин); `revoked` — токен отозван площадкой (§7.15). */
    | { ok: false, error: string, retryable: boolean, revoked?: boolean }

export type JobBoardMutationResult = { ok: true } | { ok: false, error: string, retryable: boolean, revoked?: boolean }
export type JobBoardHealthResult = { ok: true } | { ok: false, revoked: boolean, error: string }
export type JobBoardConnectResult = { ok: true, secret: string, accountLabel: string } | { ok: false, error: string }

export interface JobBoardAdapter {
  /** Заглушка всегда «доступна» — ни одна переменная окружения не читается (см. `.env.example`). */
  isConfigured(): boolean
  connect(): Promise<JobBoardConnectResult>
  publish(secret: string, payload: JobBoardPublishPayload): Promise<JobBoardPublishResult>
  update(secret: string, externalId: string, payload: JobBoardPublishPayload): Promise<JobBoardMutationResult>
  remove(secret: string, externalId: string): Promise<JobBoardMutationResult>
  health(secret: string): Promise<JobBoardHealthResult>
}

/**
 * Секрет-заглушка со смыслом «токен отозван площадкой» (§7.15). Тест или dev-инструмент
 * доводит его сюда через `jobBoardAccounts.ts#simulateProviderRevocation()` — единственный
 * путь, никаких магических полей формы.
 */
export const REVOKED_STUB_SECRET = 'stub:revoked'

/**
 * Один детерминированный адаптер на все три площадки: продукту не важно различие в API
 * вендоров, пока каждый работает по одному контракту §7.18. `publish`/`update` отказывают
 * ретраибельно, если заголовок несёт маркер `__JOBBOARD_FAIL__` — единственный крючок для
 * теста ретраев (§7.16), не влияющий на обычные вакансии.
 */
function stubAdapter(provider: JobBoardProvider): JobBoardAdapter {
  return {
    isConfigured: () => true,
    async connect() {
      return { ok: true, secret: `stub:${provider}:${randomUUID()}`, accountLabel: `${provider} (заглушка)` }
    },
    async publish(secret, payload) {
      if (secret === REVOKED_STUB_SECRET) return { ok: false, error: 'jobboard.revoked', retryable: false, revoked: true }
      if (payload.title.includes('__JOBBOARD_FAIL__')) return { ok: false, error: 'jobboard.temporary_error', retryable: true }
      const externalId = createHash('sha256').update(`${secret}:${payload.title}`).digest('hex').slice(0, 16)
      return {
        ok: true,
        externalId,
        externalUrl: `https://${provider.replace('_', '-')}.example/vacancy/${externalId}`,
        expiresAt: null, // §15 Г-29.8: заглушка не придумывает срок, которого не вернул бы вендор
      }
    },
    async update(secret, _externalId, payload) {
      if (secret === REVOKED_STUB_SECRET) return { ok: false, error: 'jobboard.revoked', retryable: false, revoked: true }
      if (payload.title.includes('__JOBBOARD_FAIL__')) return { ok: false, error: 'jobboard.temporary_error', retryable: true }
      return { ok: true }
    },
    async remove(secret) {
      if (secret === REVOKED_STUB_SECRET) return { ok: false, error: 'jobboard.revoked', retryable: false, revoked: true }
      return { ok: true }
    },
    async health(secret) {
      if (secret === REVOKED_STUB_SECRET) return { ok: false, revoked: true, error: 'jobboard.revoked' }
      return { ok: true }
    },
  }
}

export const JOB_BOARD_ADAPTERS: Record<JobBoardProvider, JobBoardAdapter> = Object.fromEntries(
  JOB_BOARD_PROVIDERS.map(p => [p, stubAdapter(p)]),
) as Record<JobBoardProvider, JobBoardAdapter>

export function adapterFor(provider: JobBoardProvider): JobBoardAdapter {
  return JOB_BOARD_ADAPTERS[provider]
}
