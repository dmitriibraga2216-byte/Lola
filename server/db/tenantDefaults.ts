import { sql } from 'drizzle-orm'
import type { PgTransaction } from 'drizzle-orm/pg-core'
import { STAGE_CAPABILITIES } from '../../shared/enums'
import type { LifecycleStageCode, StageCapability } from '../../shared/enums'

/**
 * Справочники по умолчанию для нового тенанта. Вызывается из сида и createTenant
 * (в миграции их вставлять нельзя — на чистой БД тенантов ещё нет).
 * Идемпотентно: ON CONFLICT DO NOTHING по (tenant_id, code|name).
 */
export const DEFAULT_GOAL_STATUSES = [
  { code: 'planned', name: 'Заплановано', color: 'muted', sort: 0, isInitial: true, isFinal: false, isSuccess: false, requiresComment: false, transitions: ['in_progress', 'cancelled'], who: ['development.own', 'development.team'] },
  { code: 'in_progress', name: 'В роботі', color: 'sun', sort: 1, isInitial: false, isFinal: false, isSuccess: false, requiresComment: false, transitions: ['on_review', 'cancelled'], who: ['development.own', 'development.team'] },
  { code: 'on_review', name: 'На перевірці', color: 'sun', sort: 2, isInitial: false, isFinal: false, isSuccess: false, requiresComment: false, transitions: ['achieved', 'not_achieved', 'in_progress'], who: ['development.own'] },
  { code: 'achieved', name: 'Досягнуто', color: 'teal', sort: 3, isInitial: false, isFinal: true, isSuccess: true, requiresComment: false, transitions: [], who: ['development.team'] },
  { code: 'not_achieved', name: 'Не досягнуто', color: 'coral', sort: 4, isInitial: false, isFinal: true, isSuccess: false, requiresComment: true, transitions: ['in_progress'], who: ['development.team'] },
  { code: 'cancelled', name: 'Скасовано', color: 'muted', sort: 5, isInitial: false, isFinal: true, isSuccess: false, requiresComment: true, transitions: [], who: ['development.own', 'development.team'] },
]

/** Шкалы анкет по умолчанию — `scales(kind=levels)` + `scale_levels` (docs/24 Г-24.4; Spec 20 свёл сюда прежнюю rating_scales). */
export const DEFAULT_LEVEL_SCALES = [
  { name: 'Зараховано / Не зараховано', levels: [{ value: 0, label: 'Не зараховано' }, { value: 1, label: 'Зараховано' }] },
  { name: '1–5', levels: [{ value: 1, label: 'Не відповідає' }, { value: 2, label: 'Частково' }, { value: 3, label: 'Відповідає' }, { value: 4, label: 'Вище очікувань' }, { value: 5, label: 'Взірець' }] },
  { name: 'Шкала від 0 до 10', levels: Array.from({ length: 11 }, (_, i) => ({ value: i, label: String(i) })) },
]

/**
 * Восемь этапов жизненного цикла нового тенанта (docs/v2/33-lifecycle.md §3.3, таблица
 * «Значения по умолчанию»; критерий приёмки §13 п. 12). Коды — платформенные
 * (`LIFECYCLE_STAGE_CODES`), их перечень закрыт констрейнтом миграции; здесь — **посев**,
 * одно из трёх мест, где код этапа вообще встречается буквально (справочник, посев,
 * миграция; сквозная проверка 1 `scripts/v2-crosschecks.sh`).
 *
 * `expectedDays` — норма времени в этапе (§7.11): онбординг 14, интеграция 30, аттестация 7,
 * офбординг 14; у остальных нормы нет. `color` у всех — значение по умолчанию `ink`: палитру
 * этапов ТЗ не задаёт, а выдумывать её («Чего не делать») не нужно — тенант красит сам.
 */
export const DEFAULT_LIFECYCLE_STAGES: {
  code: LifecycleStageCode
  nameUk: string
  nameEn: string
  expectedDays: number | null
  capabilities: Record<StageCapability, boolean>
}[] = [
  { code: 'recruiting', nameUk: 'Рекрутинг', nameEn: 'Recruiting', expectedDays: null, capabilities: caps({ progress: true, deadline: true, grading: true, attempts: true, review: true, graph: true, ai_generate: true, applies_to_candidate: true }) },
  { code: 'onboarding', nameUk: 'Онбординг', nameEn: 'Onboarding', expectedDays: 14, capabilities: caps({ progress: true, deadline: true, grading: true, attempts: true, review: true, certificate: true, graph: true, ai_generate: true, applies_to_employee: true, counts_in_rating: true }) },
  { code: 'integration', nameUk: 'Інтеграція', nameEn: 'Integration', expectedDays: 30, capabilities: caps({ progress: true, deadline: true, grading: true, attempts: true, review: true, graph: true, ai_generate: true, applies_to_employee: true, counts_in_rating: true }) },
  { code: 'training', nameUk: 'Підвищення кваліфікації', nameEn: 'Professional development', expectedDays: null, capabilities: caps({ progress: true, deadline: true, grading: true, attempts: true, review: true, certificate: true, graph: true, ai_generate: true, applies_to_employee: true, counts_in_rating: true }) },
  { code: 'attestation', nameUk: 'Атестація', nameEn: 'Attestation', expectedDays: 7, capabilities: caps({ progress: true, deadline: true, grading: true, attempts: true, review: true, certificate: true, graph: true, applies_to_employee: true, counts_in_rating: true }) },
  { code: 'psychological', nameUk: 'Психологічні тести', nameEn: 'Psychological tests', expectedDays: null, capabilities: caps({ progress: true, deadline: true, applies_to_candidate: true, applies_to_employee: true }) },
  { code: 'knowledge', nameUk: 'База знань', nameEn: 'Knowledge base', expectedDays: null, capabilities: caps({ ai_generate: true, applies_to_employee: true }) },
  { code: 'offboarding', nameUk: 'Офбординг', nameEn: 'Offboarding', expectedDays: 14, capabilities: caps({ progress: true, deadline: true, review: true, graph: true, applies_to_employee: true }) },
]

/** Достраивает карту возможностей до полного перечня: не указанный ключ — `false` (§3.3). */
function caps(on: Partial<Record<StageCapability, boolean>>): Record<StageCapability, boolean> {
  return Object.fromEntries(STAGE_CAPABILITIES.map(k => [k, on[k] ?? false])) as Record<StageCapability, boolean>
}

// eslint-disable-next-line @typescript-eslint/no-explicit-any
export async function ensureTenantDefaults(tx: PgTransaction<any, any, any>, tenantId: string): Promise<void> {
  const arr = (xs: string[]) => xs.length ? sql`ARRAY[${sql.join(xs.map(x => sql`${x}`), sql`, `)}]::text[]` : sql`'{}'::text[]`
  for (const s of DEFAULT_GOAL_STATUSES) {
    await tx.execute(sql`
      insert into goal_statuses (tenant_id, code, name, color, sort, is_initial, is_final, is_success, requires_comment, allowed_transitions, who_can_set)
      values (${tenantId}::uuid, ${s.code}, ${s.name}, ${s.color}, ${s.sort}, ${s.isInitial}, ${s.isFinal}, ${s.isSuccess}, ${s.requiresComment}, ${arr(s.transitions)}, ${arr(s.who)})
      on conflict (tenant_id, code) do nothing`)
  }
  for (const s of DEFAULT_LEVEL_SCALES) {
    const rows = await tx.execute(sql`
      insert into scales (tenant_id, name, kind, display_as)
      values (${tenantId}::uuid, ${s.name}, 'levels', 'label')
      on conflict (tenant_id, name) do nothing returning id`) as unknown as { id: string }[]
    const id = rows[0]?.id
    if (!id) continue
    for (const [i, l] of s.levels.entries()) {
      await tx.execute(sql`insert into scale_levels (tenant_id, scale_id, label, value, sort_order) values (${tenantId}::uuid, ${id}::uuid, ${l.label}, ${l.value}, ${i})`)
    }
  }
  for (const [i, s] of DEFAULT_LIFECYCLE_STAGES.entries()) {
    await tx.execute(sql`
      insert into lifecycle_stages (tenant_id, code, name_uk, name_en, sort, expected_days, capabilities)
      values (${tenantId}::uuid, ${s.code}, ${s.nameUk}, ${s.nameEn}, ${i}, ${s.expectedDays}, ${JSON.stringify(s.capabilities)}::jsonb)
      on conflict (tenant_id, code) do nothing`)
  }
}
