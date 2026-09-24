import { expireApplications, pruneApplyAttempts } from '../services/publicApply'

/**
 * Фоновые задачи публичного контура вакансии (docs/v2/29-vacancies.md §11,
 * план docs/v2/45-plan.md PR-16). Обе раскладываются по тенантам кругом `runPerTenant`
 * (docs/25 §5); круг строится по тенантам с включённым рекрутингом — фильтр стоит в
 * воркере, а не здесь: задача обязана отработать по любому тенанту, которого ей назвали,
 * в том числе из теста.
 */

/**
 * `vacancy.application_expire` — ежечасно (§11, критерий `29` §13 к. 6): отклик без
 * подтверждённого кода старше суток уходит в `expired`. Кандидат не создан, ось
 * `candidates_active` не тронута, временное резюме удалено.
 */
export async function vacancyApplicationExpireTenant(tenantId: string): Promise<number> {
  return expireApplications(tenantId)
}

/** `vacancy.attempts_gc` — ежедневно 03:40 (§11): журнал попыток старше 30 дней не нужен никому. */
export async function vacancyAttemptsGcTenant(tenantId: string): Promise<number> {
  return pruneApplyAttempts(tenantId)
}
