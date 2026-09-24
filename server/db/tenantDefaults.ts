import { sql } from 'drizzle-orm'
import type { PgTransaction } from 'drizzle-orm/pg-core'
import { MEDIA_ORIGINS, STAGE_CAPABILITIES, SYSTEM_CANDIDATE_STATUSES, SYSTEM_PERSON_DOCUMENT_TYPES } from '../../shared/enums'
import { DEFAULT_SHOP_CATEGORIES } from '../../shared/domain/gamification'
import type { LifecycleStageCode, MediaOrigin, StageCapability, StorageRetentionAction, StorageRetentionAnchor } from '../../shared/enums'

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

/**
 * Политики хранения по умолчанию — строка на каждое происхождение (docs/v2/34 §7.3, для трёх
 * значений, добавленных позже, — docs/v2/40 §4.3). **Все выключены** у нового тенанта (§7.3:
 * «первое включение требует сухого прогона и подтверждения объёма»). `Record` по
 * `MediaOrigin`, а не массив: новое значение перечня без своей строки здесь не скомпилируется.
 *
 * Где документ ставит «—» (сертификат, контент, бренд, аватар, документ человека), срока нет:
 * такие файлы живут вместе с источником и чистятся только осиротением (§7.6). Точка отсчёта у
 * них `created_at` — нейтральная, потому что политика выключена и срока всё равно нет.
 * `report_export` — «30 дн.» документа: срок хранится в месяцах (1–120), ближайшее — 1.
 *
 * Срок корзины (`trashDays`) у всех 30 дней — предварительное решение docs/v2/44 §8; значение
 * живёт в строке и меняется без релиза.
 */
export const DEFAULT_TRASH_DAYS = 30

export const DEFAULT_RETENTION_POLICIES: Record<MediaOrigin, {
  keepMonths: number | null
  anchor: StorageRetentionAnchor
  action: StorageRetentionAction
  keepEvidence: boolean
}> = {
  video_answer: { keepMonths: 12, anchor: 'graded_at', action: 'soft_delete', keepEvidence: true },
  workshop_submission: { keepMonths: 12, anchor: 'graded_at', action: 'soft_delete', keepEvidence: true },
  checklist_photo: { keepMonths: 12, anchor: 'created_at', action: 'soft_delete', keepEvidence: true },
  candidate_cv: { keepMonths: 6, anchor: 'created_at', action: 'soft_delete', keepEvidence: true },
  ai_artifact: { keepMonths: 12, anchor: 'created_at', action: 'soft_delete', keepEvidence: true },
  other: { keepMonths: 6, anchor: 'last_accessed_at', action: 'soft_delete', keepEvidence: true },
  import: { keepMonths: 3, anchor: 'created_at', action: 'purge', keepEvidence: true },
  report_export: { keepMonths: 1, anchor: 'created_at', action: 'purge', keepEvidence: true },
  certificate: { keepMonths: null, anchor: 'created_at', action: 'notify_only', keepEvidence: true },
  content_cover: { keepMonths: null, anchor: 'created_at', action: 'soft_delete', keepEvidence: true },
  lesson_attachment: { keepMonths: null, anchor: 'created_at', action: 'soft_delete', keepEvidence: true },
  brand_asset: { keepMonths: null, anchor: 'created_at', action: 'soft_delete', keepEvidence: true },
  avatar: { keepMonths: null, anchor: 'created_at', action: 'soft_delete', keepEvidence: true },
  interview_answer: { keepMonths: 3, anchor: 'created_at', action: 'purge', keepEvidence: false },
  person_document: { keepMonths: null, anchor: 'created_at', action: 'notify_only', keepEvidence: true },
  issue_screenshot: { keepMonths: 6, anchor: 'created_at', action: 'purge', keepEvidence: false },
}

/**
 * Досевает недостающие строки политик тенанта (идемпотентно). Зовётся посевом тенанта и
 * сервисом хранилища при первом обращении — так тенант, заведённый до PR-36, получает строки
 * без копии умолчаний в SQL миграции, а новое значение `origin` — без отдельной миграции данных.
 */
// eslint-disable-next-line @typescript-eslint/no-explicit-any
export async function ensureRetentionPolicies(tx: PgTransaction<any, any, any>, tenantId: string): Promise<void> {
  const values = MEDIA_ORIGINS.map((origin) => {
    const p = DEFAULT_RETENTION_POLICIES[origin]
    return sql`(${tenantId}::uuid, ${origin}, false, ${p.keepMonths}::int, ${p.anchor}, ${p.action}, ${p.keepEvidence}, ${DEFAULT_TRASH_DAYS}::int)`
  })
  await tx.execute(sql`
    insert into storage_retention_policies (tenant_id, origin, enabled, keep_months, anchor, action, keep_evidence, trash_days)
    values ${sql.join(values, sql`, `)}
    on conflict (tenant_id, origin) do nothing`)
}

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
  // Шесть системных колонок воронки (docs/v2/28 §3.3): их нельзя удалить и переименовать `code`.
  // Тот же список — в миграции 0064_v2_candidates догоняющей вставкой для уже заведённых тенантов.
  for (const [i, s] of SYSTEM_CANDIDATE_STATUSES.entries()) {
    await tx.execute(sql`
      insert into candidate_statuses (tenant_id, code, name_uk, name_en, color, sort, is_system, maps_to)
      values (${tenantId}::uuid, ${s.code}, ${s.nameUk}, ${s.nameEn}, ${s.color}, ${i}, true, ${s.mapsTo})
      on conflict (tenant_id, code) do nothing`)
  }
  for (const [i, s] of DEFAULT_LIFECYCLE_STAGES.entries()) {
    await tx.execute(sql`
      insert into lifecycle_stages (tenant_id, code, name_uk, name_en, sort, expected_days, capabilities)
      values (${tenantId}::uuid, ${s.code}, ${s.nameUk}, ${s.nameEn}, ${i}, ${s.expectedDays}, ${JSON.stringify(s.capabilities)}::jsonb)
      on conflict (tenant_id, code) do nothing`)
  }
  // Стартовые категории магазина подарков — решение владельца продукта (docs/21 Г-21.1, 24.09.2026):
  // мерч, вихідні дні, знижки, «щось у закладі». Дальше справочник ведёт администратор тенанта.
  // Тот же список — в миграции `gamification` догоняющей вставкой для уже заведённых тенантов.
  for (const [i, name] of DEFAULT_SHOP_CATEGORIES.entries()) {
    await tx.execute(sql`
      insert into shop_categories (tenant_id, name, sort)
      values (${tenantId}::uuid, ${name}, ${i})
      on conflict (tenant_id, name) do nothing`)
  }
  // Семь системных типов документов человека (docs/v2/38 §3.5): удалить нельзя, править — можно.
  // Тот же список — в миграции v2_person_notes_docs догоняющей вставкой для уже заведённых тенантов.
  for (const s of SYSTEM_PERSON_DOCUMENT_TYPES) {
    await tx.execute(sql`
      insert into person_document_types (tenant_id, code, name, is_system, is_required, validity_months, is_fact_only, self_upload)
      values (${tenantId}::uuid, ${s.code}, ${s.name}, true, ${s.isRequired}, ${s.validityMonths}, ${s.isFactOnly}, ${s.selfUpload})
      on conflict (tenant_id, code) do nothing`)
  }
  // Политики хранения — строка на происхождение, все выключены (docs/v2/34 §7.3, PR-36)
  await ensureRetentionPolicies(tx, tenantId)
}
