import { candidateAutoArchive, candidateConsentSweep, candidateStaleDigest } from '../services/candidateJobs'

/**
 * Ночные задачи воронки одного тенанта (docs/v2/28-recruiting-candidates.md §11,
 * план docs/v2/45-plan.md PR-14). Обе ставятся планировщиком pg-boss по расписанию и
 * раскладываются по тенантам кругом `runPerTenant` (docs/25 §5): падение одного тенанта
 * не трогает остальных, приостановленные пропускаются.
 *
 * Тенанты с выключенным рекрутингом (`tenants.candidates_enabled = false`) до задач не
 * доходят вовсе — фильтр стоит в воркере, а не здесь: задача должна уметь отработать по
 * любому тенанту, которого ей назвали, в том числе из теста.
 */

/** `candidate.auto_archive` — ежедневно 03:00 (§11): отказанные старше N дней уходят в архив. */
export async function candidateAutoArchiveTenant(tenantId: string): Promise<number> {
  return candidateAutoArchive(tenantId)
}

/**
 * `candidate.consent_sweep` — ежедневно 03:20 (§11): стирание ПД по истёкшему согласию
 * и предупреждение рекрутеру за 14 дней. Дайджест «застрявших» (§8 `candidate.stale`) идёт
 * тем же проходом по понедельникам — отдельного круга по тенантам он не стоит.
 */
export async function candidateConsentSweepTenant(tenantId: string, monday = new Date().getDay() === 1): Promise<{ erased: number, warned: number, stale: number }> {
  const sweep = await candidateConsentSweep(tenantId)
  const stale = monday ? await candidateStaleDigest(tenantId).catch(() => 0) : 0
  return { ...sweep, stale }
}
