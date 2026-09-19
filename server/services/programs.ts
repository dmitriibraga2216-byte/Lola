import type { TenantTx } from '../utils/withTenant'

/**
 * Программы и траектории (docs/17). Здесь — точка привязки к правилам автоматизации
 * (§3.4 режим `automation`, §7.8): правило определяет аудиторию, программа — что назначать.
 * Полная реализация — отдельный этап; пока правило без программ ничего не назначает.
 */
export async function assignProgramsForRule(_tx: TenantTx, _tenantId: string, _ruleId: string, _userId: string, _opts: { dryRun: boolean, delayDays: number }): Promise<{ type: 'assign_program', programId: string, wouldAssign?: boolean }[]> {
  return []
}

/** Какие программы ссылаются на правила («ВИКОРИСТОВУЄТЬСЯ ДЛЯ»). */
export async function programsUsingRules(_tx: TenantTx, _ruleIds: string[]): Promise<Map<string, { id: string, title: string }[]>> {
  return new Map()
}
